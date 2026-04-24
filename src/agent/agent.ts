import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Session } from "../session/repository";
import { Repository } from "../session/repository";
import { HasMessages, type SessionRequest } from "./types";
import { PromptTemplate } from "../prompt";
import { SkillsLoader } from "../skills";
import { PlanTools } from "../tools/plan";
import { TerminalTools } from "../tools/terminal";
import { FileSystemTools } from "../tools/filesystem";
import { WebTools } from "../tools/web";

import type { Graph } from "./graph";
import { type Process } from "../process";
import { createModel } from "./providers";
import { makeReActGraph, type ReActEvent } from "./react";
import { type Topic, NullTopic } from "../bus";
import { logger } from "../logging";
import { MCPClientManager } from "../mcp";
import { MCPToolsPlugin } from "./mcp-tools-plugin";
import { SummarizationPlugin, type SummarizationPluginConfig } from "./summarization-plugin";
import { resolveContextWindowSize } from "./providers";
import { RalphModePlugin } from "./ralph-mode-plugin";
import type { AgentCommand } from "./types";
import { main } from "bun";


/**
 * Session-level lifecycle events emitted by AgentProcess on the sessionEventTopic.
 * Consumers can subscribe to track conversation progress and handle errors.
 */
export type AgentSessionEvent =
    | { type: 'session_turn_complete'; sessionId: string; messageCount: number }
    | { type: 'session_error'; sessionId: string; error: string }
    | { type: 'session_fatal_error'; sessionId: string; error: string };

enum AgentMode {
    PLAN = "plan", // in plan mode, the agent has not access to the filesystem writing tools. It can only create and manage a plan of tasks to achieve its goal, and optionally use tools that are relevant for planning (e.g. a calendar tool to schedule tasks, or a search tool to research how to achieve certain tasks).
    AGENT = "agent", // in agent mode, the agent has full access to the filesystem writing tools and can execute tasks directly.
}

/**
 * Resolve runtime mode with explicit intent:
 * - sub-agents always run in agent mode
 * - top-level agents honor persisted mode when valid
 * - unknown/missing modes fall back to plan mode
 */
export function resolveInitialAgentMode(sessionMode: string | undefined, isSubAgent: boolean): "plan" | "agent" {
    if (isSubAgent) {
        return "agent";
    }
    if (sessionMode === AgentMode.AGENT) {
        return "agent";
    }
    return "plan";
}

export class AgentState extends HasMessages {
    model: string = "";
    modelConfiguration: Record<string, unknown> = {};
    mode: AgentMode = AgentMode.PLAN;
    isSubAgent: boolean = false;
    sessionId: string = "";
    conversationId: number = 0;
    turnCount: number = 0;
    remainingRaphIterations: number = 0;
    pluginData: Record<string, unknown> = {};
    constructor() { super([]); }
}

export interface PluginChain {
    doNextBeforeConversation(state: AgentState): Promise<AgentState>;
    doNextAfterConversation(state: AgentState): Promise<AgentState>;
    doNextBeforeTurn(state: AgentState): Promise<AgentState>;
    doNextAfterTurn(state: AgentState): Promise<AgentState>;
    doNextGetToolSet(): Promise<ToolSet>;
    /** Find the first graph-providing plugin and execute it with the full chain available for tool queries. */
    doNextGetGraph(state: AgentState): Promise<Graph<AgentState>>;
    /** Find the first graph provider after the given plugin name. Useful for graph-wrapping plugins. */
    doNextGetGraphAfter?(state: AgentState, pluginName: string): Promise<Graph<AgentState>>;
    /** Fan an inbound command to all plugins that declare onCommand. */
    doNextOnCommand(state: AgentState, command: AgentCommand): Promise<void>;
    stateGetter: () => AgentState;
}

class PluginChainImpl implements PluginChain {

    constructor(private plugins: AgentPlugin[], private state: AgentState) { }

    /** Returns a getter for the current mutable state. Used by tool closures (e.g. mode-switching tools) to read/mutate state during graph execution. */
    get stateGetter(): () => AgentState {
        return () => this.state;
    }

    async doNextBeforeConversation(state: AgentState): Promise<AgentState> {
        if (this.plugins.length === 0) return state;
        const [nextPlugin, ...remainingPlugins] = this.plugins;
        const nextChain = new PluginChainImpl(remainingPlugins, state);
        if (nextPlugin!.beforeConversation) {
            return await nextPlugin!.beforeConversation(state, nextChain);
        }
        return await nextChain.doNextBeforeConversation(state);
    }

    async doNextAfterConversation(state: AgentState): Promise<AgentState> {
        if (this.plugins.length === 0) return state;
        const [nextPlugin, ...remainingPlugins] = this.plugins;
        const nextChain = new PluginChainImpl(remainingPlugins, state);
        if (nextPlugin!.afterConversation) {
            return await nextPlugin!.afterConversation(state, nextChain);
        }
        return await nextChain.doNextAfterConversation(state);
    }

    async doNextBeforeTurn(state: AgentState): Promise<AgentState> {
        if (this.plugins.length === 0) return state;
        const [nextPlugin, ...remainingPlugins] = this.plugins;
        const nextChain = new PluginChainImpl(remainingPlugins, state);
        if (nextPlugin!.beforeTurn) {
            return await nextPlugin!.beforeTurn(state, nextChain);
        }
        return await nextChain.doNextBeforeTurn(state);
    }

    async doNextAfterTurn(state: AgentState): Promise<AgentState> {
        if (this.plugins.length === 0) return state;
        const [nextPlugin, ...remainingPlugins] = this.plugins;
        const nextChain = new PluginChainImpl(remainingPlugins, state);
        if (nextPlugin!.afterTurn) {
            return await nextPlugin!.afterTurn(state, nextChain);
        }
        return await nextChain.doNextAfterTurn(state);
    }

    async doNextGetToolSet(): Promise<ToolSet> {
        if (this.plugins.length === 0) return {};
        const [nextPlugin, ...remainingPlugins] = this.plugins;
        const nextChain = new PluginChainImpl(remainingPlugins, this.state);
        if (nextPlugin!.getToolSet) {
            return await nextPlugin!.getToolSet(this.state, nextChain);
        }
        return await nextChain.doNextGetToolSet();
    }

    private async resolveGraphFromIndex(state: AgentState, startIndex: number): Promise<Graph<AgentState>> {
        for (let i = startIndex; i < this.plugins.length; i++) {
            const plugin = this.plugins[i];
            if (plugin?.getGraph) {
                const fullChain = new PluginChainImpl(this.plugins, state);
                return await plugin.getGraph(state, fullChain);
            }
        }
        throw new Error('No plugin in the chain provided a graph implementation');
    }

    /**
     * Finds the first plugin that provides a graph and invokes it.
     */
    async doNextGetGraph(state: AgentState): Promise<Graph<AgentState>> {
        return this.resolveGraphFromIndex(state, 0);
    }

    /**
     * Finds the first graph provider after a specific plugin name.
     * Used by plugins that decorate/wrap another graph provider.
     */
    async doNextGetGraphAfter(state: AgentState, pluginName: string): Promise<Graph<AgentState>> {
        const pluginIndex = this.plugins.findIndex((plugin) => plugin.name === pluginName);
        if (pluginIndex === -1) {
            throw new Error(`Plugin '${pluginName}' was not found in the plugin chain`);
        }
        return this.resolveGraphFromIndex(state, pluginIndex + 1);
    }

    async doNextOnCommand(state: AgentState, command: AgentCommand): Promise<void> {
        for (const plugin of this.plugins) {
            if (plugin.onCommand) {
                await plugin.onCommand(state, command, this);
            }
        }
    }
}

export interface AgentPlugin {
    name: string;
    description: string;
    beforeConversation?(state: AgentState, chain: PluginChain): Promise<AgentState>;
    afterConversation?(state: AgentState, chain: PluginChain): Promise<AgentState>;
    beforeTurn?(state: AgentState, chain: PluginChain): Promise<AgentState>;
    afterTurn?(state: AgentState, chain: PluginChain): Promise<AgentState>;
    getToolSet?(state: AgentState, chain: PluginChain): Promise<ToolSet>;
    /** Optional: provide a custom execution graph (e.g. a ReAct graph with specific tools). */
    getGraph?(state: AgentState, chain: PluginChain): Promise<Graph<AgentState>>;
    /** Optional: handle an inbound command sent to the running agent. */
    onCommand?(state: AgentState, command: AgentCommand, chain: PluginChain): Promise<void>;
}

class SystemPromptPlugin implements AgentPlugin {
    description = "System prompt plugin";
    name = "SystemPromptPlugin"

    /** @param planTools - Optional task tracker to include the current plan in the system prompt. */
    constructor(private workspace: string) {
    }

    async beforeConversation(state: AgentState, chain: PluginChain): Promise<AgentState> {

        const builtInTools = state.pluginData["BuiltInToolsProviderPlugin"];
        const planTools: PlanTools | undefined = builtInTools?.["planTools"] as PlanTools | undefined;

        if (!state.firstSystemMessage) {
            const promptTemplate = PromptTemplate.makeAgentTemplate(this.workspace, planTools);

            const systemPrompt = await promptTemplate.render({ currentMode: state.mode });
            state.setFirstSystemMessage(systemPrompt);
        }
        return chain.doNextBeforeConversation(state);
    }
}
class BuiltInToolsProviderPlugin implements AgentPlugin {
    name = "BuiltInToolsProviderPlugin";
    description = "Provides The set of tools available to the agent"

    private filesystemTools: FileSystemTools;
    private terminalTools: TerminalTools;
    private webTools: WebTools;
    private planTools: PlanTools;

    constructor(workspace: string) {
        this.filesystemTools = new FileSystemTools(workspace);
        this.terminalTools = new TerminalTools(workspace);
        this.webTools = new WebTools(workspace);
        this.planTools = new PlanTools(workspace);
    }

    async getToolSet(state: AgentState, chain: PluginChain): Promise<ToolSet> {
        let toolSet = await chain.doNextGetToolSet();

        // add filesystem tools with write operations gated on agent mode
        toolSet = {
            ...toolSet,
            ...this.filesystemTools.getToolSet(state.mode == AgentMode.AGENT), // only allow file writing operations in agent mode
        }

        // add terminal tools (todo restring only to agent mode)
        toolSet = {
            ...toolSet,
            ...this.terminalTools.getToolSet(),
        }

        // add plan tools (todo: should we restrict to plan mode only?)
        toolSet = {
            ...toolSet,
            ...this.planTools.getToolSet(),
        }

        // add web tools
        toolSet = {
            ...toolSet,
            ...(await this.webTools.getToolSet()),
        }
        
        return toolSet;
    }

    beforeConversation(state: AgentState, chain: PluginChain): Promise<AgentState> {
        state.pluginData[this.name] = {
            filesystemTools: this.filesystemTools,
            terminalTools: this.terminalTools,
            webTools: this.webTools,
            planTools: this.planTools,
        };
        return chain.doNextBeforeConversation(state);
    }
}

/**
 * Core plugin that injects skill tools discovered from the workspace.
 */
class SkillsToolsPlugin implements AgentPlugin {
    name = "SkillsToolsPlugin";
    description = "Adds core skill tools from the workspace.";

    private readonly skillsLoader: SkillsLoader;

    constructor(workspace: string) {
        this.skillsLoader = new SkillsLoader(workspace);
    }

    async getToolSet(_state: AgentState, chain: PluginChain): Promise<ToolSet> {
        const toolSet = await chain.doNextGetToolSet();
        return {
            ...toolSet,
            ...this.skillsLoader.getTools(),
        };
    }
}

class ReActAgentPlugin implements AgentPlugin {
    name = "ReActAgentPlugin";
    description = "Provides a ReAct graph for agent reasoning and tool execution.";

    constructor(
        private readonly eventTopic: Topic<ReActEvent> = NullTopic as Topic<ReActEvent>
    ) { }

    async getGraph(state: AgentState, chain: PluginChain): Promise<Graph<AgentState>> {
        const graph = makeReActGraph({
            model: await createModel(state.model, state.modelConfiguration),
            name: "ReActAgentPluginGraph",
            // chain here is the full-plugin chain (see PluginChainImpl.doNextGetGraph),
            // so doNextGetToolSet() collects tools from all tool-providing plugins.
            toolsProvider: async () => chain.doNextGetToolSet(),
            eventTopic: this.eventTopic,
        });
        return graph as Graph<AgentState>;
    }
}

/**
 * The core agent process. Register this with a ProcessManager to run it.
 *
 * Responsibilities:
 * - Runs the plugin lifecycle (beforeConversation → turn loop → afterConversation).
 * - Each turn: appends user message → beforeTurn → execute graph → afterTurn → emit event.
 * - Publishes session lifecycle events on sessionEventTopic.
 * - ReAct model/tool streaming events are published on the reactEventTopic passed to ReActAgentPlugin.
 * - Persists session activity and final status via the repository.
 * - Respects the AbortSignal provided by ProcessManager (cancellation / timeout).
 */
export class AgentProcess implements Process {

    /** Plugins are executed in order. Push additional plugins before calling execute(). */
    plugins: AgentPlugin[] = [];

    private state: AgentState = new AgentState();

    get name(): string {
        return `AgentProcess-${this.session.id}`;
    }

    get description(): string {
        return `Agent process for session ${this.session.id}`;
    }

    /**
     * @param workspace - Workspace root directory (used by tools and prompt templates).
     * @param session - Session record from the repository (provides model name, mode, etc.).
     * @param repository - Repository for persisting session activity and final status.
     * @param incomingRequestConsumer - Called to register a handler for the next user message.
     *   The handler is invoked once when a request arrives.
     * @param sessionEventTopic - Topic for session lifecycle events (turn_complete, error, fatal_error).
     *   Defaults to NullTopic (events are silently dropped).
     * @param reactEventTopic - Topic for ReAct streaming events (reasoning chunks, tool calls, etc.).
     *   Defaults to NullTopic.
     * @param summarizationConfig - Optional configuration for the SummarizationPlugin.
     *   If provided, enables automatic conversation summarization when token usage exceeds threshold.
     * @param ralphIterations - Initial Ralph-mode iteration count.
     * @param commandTopic - Optional inbound topic for sending commands to this agent while it is running.
     */
    constructor(
        private readonly workspace: string,
        private readonly session: Session,
        private readonly repository: Repository,
        private readonly incomingRequestConsumer: (callback: (request: SessionRequest | undefined) => void) => void,
        private readonly sessionEventTopic: Topic<AgentSessionEvent> = NullTopic as Topic<AgentSessionEvent>,
        private readonly reactEventTopic: Topic<ReActEvent> = NullTopic as Topic<ReActEvent>,
        private readonly summarizationConfig?: SummarizationPluginConfig,
        private readonly ralphIterations: number = 0,
        private readonly commandTopic?: Topic<AgentCommand>,
    ) {
        this.plugins.push(new SystemPromptPlugin(workspace));
        this.plugins.push(new RalphModePlugin(ralphIterations));
        this.plugins.push(new MCPToolsPlugin(new MCPClientManager(workspace)));
        this.plugins.push(new BuiltInToolsProviderPlugin(workspace));
        this.plugins.push(new SkillsToolsPlugin(workspace));
        // Note: SummarizationPlugin will be added in execute() after model is created
        this.plugins.push(new ReActAgentPlugin(reactEventTopic));
    }

    /** Register an additional plugin (e.g. manager-provided cross-cutting capabilities). */
    usePlugin(plugin: AgentPlugin): void {
        this.plugins.push(plugin);
    }

    async execute(signal?: AbortSignal): Promise<void> {
        const sessionId = this.session.id;
        logger.info({ sessionId }, 'Starting agent process');

        // Initialize mutable conversation state from the session configuration
        this.state = new AgentState();
        this.state.model = this.session.modelName;
        this.state.sessionId = String(sessionId);
        this.state.isSubAgent = this.session.parentSessionId !== undefined;
        this.state.mode = resolveInitialAgentMode(this.session.mode, this.state.isSubAgent) as AgentMode;
        this.state.conversationId = this.repository.ensureConversation(sessionId);

        // Subscribe to inbound commands and fan them out to plugins via the chain.
        // Each plugin is responsible for handling the commands relevant to it.
        // Subscription is held until the process ends (see finally block below).
        let commandSubId: string | undefined;

        // Add SummarizationPlugin if configured
        if (this.summarizationConfig) {
            const model = await createModel(this.state.model, this.state.modelConfiguration);
            const contextWindowSize =
                this.summarizationConfig.contextWindowSize ??
                (await resolveContextWindowSize(this.state.model, this.state.modelConfiguration));
            const summarizationPlugin = new SummarizationPlugin(
                model,
                this.repository,
                {
                    ...this.summarizationConfig,
                    contextWindowSize,
                    modelName: this.state.model,
                    reactEventTopic: this.reactEventTopic,
                }
            );
            // Insert before ReActAgentPlugin so it can track tokens after execution
            const reactPluginIndex = this.plugins.findIndex((p) => p.name === "ReActAgentPlugin");
            if (reactPluginIndex !== -1) {
                this.plugins.splice(reactPluginIndex, 0, summarizationPlugin);
            } else {
                this.plugins.push(summarizationPlugin);
            }
        }

        // Build the plugin chain over the full plugin list.
        // The same chain is reused across the entire conversation so that
        // stateGetter() always returns the live, mutable state object.
        const chain = new PluginChainImpl(this.plugins, this.state);

        // Subscribe to inbound commands and fan them out to plugins via the chain.
        // Each plugin is responsible for handling the commands relevant to it.
        commandSubId = this.commandTopic?.subscribe(async (cmd) => {
            await chain.doNextOnCommand(this.state, cmd);
        });

        // Run beforeConversation hooks (e.g. system prompt injection)
        await chain.doNextBeforeConversation(this.state);

        try {
            // Agent loop: one iteration per user turn
            while (!signal?.aborted) {
                // Wait for the next user request; resolve null if the abort signal fires first
                const request = await new Promise<SessionRequest | null>((resolve) => {
                    if (signal?.aborted) { resolve(null); return; }
                    const onAbort = () => resolve(null);
                    signal?.addEventListener('abort', onAbort, { once: true });
                    this.incomingRequestConsumer((req) => {
                        signal?.removeEventListener('abort', onAbort);
                        resolve(req ?? null);
                    });
                });

                if (!request || signal?.aborted) break;

                logger.info({ sessionId, requestType: request.type }, 'Received user request');

                // Append the user message to the accumulated conversation
                this.state.appendMessages([{
                    role: 'user',
                    content: request.payload,
                }]);

                // Run beforeTurn hooks
                await chain.doNextBeforeTurn(this.state);

                try {
                    // Obtain the execution graph from the plugin chain (typically a ReAct graph)
                    const graph = await chain.doNextGetGraph(this.state);

                    // Execute the model + tool loop; this updates this.state.messages in place
                    await graph.execute(this.state);

                    logger.debug({ sessionId, messageCount: this.state.messages.length }, 'Graph execution completed');

                    // Persist session activity timestamp
                    this.repository.updateSessionActivity(sessionId);

                    // Run afterTurn hooks
                    await chain.doNextAfterTurn(this.state);

                    this.state.turnCount++;

                    await this.sessionEventTopic.publish({
                        type: 'session_turn_complete',
                        sessionId: String(sessionId),
                        messageCount: this.state.messages.length,
                    });

                } catch (error) {
                    logger.error({ sessionId, err: error }, 'Error during turn processing');
                    await this.sessionEventTopic.publish({
                        type: 'session_error',
                        sessionId: String(sessionId),
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            // Run afterConversation hooks
            await chain.doNextAfterConversation(this.state);

        } catch (error) {
            logger.error({ sessionId, err: error }, 'Fatal error in agent process');
            this.repository.updateSessionStatus(sessionId, 'failed');
            await this.sessionEventTopic.publish({
                type: 'session_fatal_error',
                sessionId: String(sessionId),
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            if (commandSubId) this.commandTopic?.unsubscribe(commandSubId);
        }

        this.repository.updateSessionStatus(sessionId, 'completed');
        logger.info({ sessionId }, 'Agent process completed');
    }
}