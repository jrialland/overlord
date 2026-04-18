import { type Tool, type ToolSet } from "ai";
import { z } from "zod";
import { AgentProcess, type AgentPlugin, type AgentSessionEvent } from "./agent";
import { type SessionRequest } from "./types";
import { MCPClientManager } from "../mcp";
import type { MCPConfig } from "../mcp/types";
import { Repository, type Session } from "../session/repository";
import { logger } from "../logging";
import { ProcessManager } from "../process";
import { MCPToolsPlugin } from "./mcp-tools-plugin";
import { NullTopic, type Topic } from "../bus";
import type { ReActEvent } from "./react";
import type { SummarizationPluginConfig } from "./summarization-plugin";
import type { AgentCommand } from "./types";

interface StartAgentOptions {
    timeoutMs?: number;
    sessionEventTopic?: Topic<AgentSessionEvent>;
    reactEventTopic?: Topic<ReActEvent>;
    startMode?: 'plan' | 'agent';
    summarizationConfig?: SummarizationPluginConfig;
    ralphIterations?: number;
    commandTopic?: Topic<AgentCommand>;
}

/**
 * Tool plugin injected into top-level agents to manage sub-agents.
 * This plugin is intentionally not available to sub-agents to avoid unbounded recursion.
 */
class SubAgentManagementPlugin implements AgentPlugin {
    name = "SubAgentManagementPlugin";
    description = "Provides tools to create and inspect sub-agents for the current parent agent session.";

    constructor(
        private readonly manager: AgentManager,
        private readonly parentSession: Session,
    ) {}

    async getToolSet(_state: unknown, chain: { doNextGetToolSet(): Promise<ToolSet> }): Promise<ToolSet> {
        const toolSet = await chain.doNextGetToolSet();

        // Sub-agents cannot spawn more sub-agents.
        if (this.parentSession.parentSessionId !== undefined) {
            return toolSet;
        }

        return {
            ...toolSet,
            "CreateSubAgent": {
                description: "Creates and starts a sub-agent to execute the provided instructions in parallel.",
                inputSchema: z.object({
                    instructions: z.string().describe("Detailed instructions for the sub-agent task."),
                    activeSkill: z.string().optional().describe("Optional active skill identifier to highlight in the instructions."),
                    timeoutMs: z.number().int().positive().optional().describe("Optional timeout for the sub-agent process."),
                }),
                execute: async (input: { instructions: string; activeSkill?: string; timeoutMs?: number }) => {
                    return this.manager.createAndRunSubAgent(this.parentSession, input.instructions, input.activeSkill, {
                        timeoutMs: input.timeoutMs,
                    });
                },
            } as Tool,
            "GetSubAgentStatus": {
                description: "Returns lifecycle status details for a sub-agent by session ID.",
                inputSchema: z.object({
                    agentId: z.string().describe("Sub-agent session ID."),
                }),
                execute: async (input: { agentId: string }) => {
                    return this.manager.getSubAgentStatus(input.agentId);
                },
            } as Tool,
            "ListSubAgents": {
                description: "Lists all sub-agent sessions created by a parent agent.",
                inputSchema: z.object({
                    parentAgentId: z.string().describe("Parent agent session ID."),
                }),
                execute: async (input: { parentAgentId: string }) => {
                    return this.manager.listSubAgents(input.parentAgentId);
                },
            } as Tool,
        };
    }
}

/**
 * Owns creation and runtime lifecycle of AgentProcess instances.
 *
 * Responsibilities:
 * - Session creation/loading through Repository.
 * - Process registration and execution through ProcessManager.
 * - Plugin injection for manager-owned capabilities (skills, MCP, sub-agent tools).
 */
export class AgentManager extends ProcessManager {

    private readonly mcpClientManager: MCPClientManager;
    private readonly repository: Repository;

    // Tracks the latest process registration/run linked to each session.
    private readonly processNameBySession = new Map<number, string>();
    private readonly processInstanceBySession = new Map<number, string>();

    constructor(private readonly workspace: string) {
        super();
        this.repository = new Repository(workspace);
        this.mcpClientManager = new MCPClientManager(workspace);
    }

    /** Connect configured MCP servers once before spawning agents that should use MCP tools. */
    async connectMcp(config: MCPConfig): Promise<void> {
        await this.mcpClientManager.connect(config);
    }

    /**
     * Creates a new top-level session and starts its AgentProcess.
     */
    createAndRunAgent(
        modelName: string,
        incomingRequestConsumer: (callback: (request: SessionRequest | undefined) => void) => void,
        modelConfig: Record<string, unknown> = {},
        options: StartAgentOptions = {},
    ): { session: Session; processName: string; processId: string } {
        const session = this.repository.createSession(
            modelName,
            this.serializeModelConfig(modelConfig),
            undefined,
            options.startMode ?? 'plan',
        );
        return this.startAgentForSession(session.id, incomingRequestConsumer, options);
    }

    /**
     * Builds, registers and runs an AgentProcess for an existing session.
     */
    startAgentForSession(
        sessionId: number,
        incomingRequestConsumer: (callback: (request: SessionRequest | undefined) => void) => void,
        options: StartAgentOptions = {},
    ): { session: Session; processName: string; processId: string } {
        const session = this.repository.getSession(sessionId);
        if (!session) {
            throw new Error(`Session with ID ${sessionId} not found`);
        }

        const process = this.buildAgentProcess(
            session,
            incomingRequestConsumer,
            options.sessionEventTopic,
            options.reactEventTopic,
            options.summarizationConfig,
            options.ralphIterations,
            options.commandTopic,
        );
        this.registerProcess(process);
        const processId = this.runProcess(process.name, { timeoutMs: options.timeoutMs });

        this.processNameBySession.set(session.id, process.name);
        this.processInstanceBySession.set(session.id, processId);

        logger.info({ sessionId: session.id, processName: process.name, processId }, 'Started agent process');
        return { session, processName: process.name, processId };
    }

    /**
     * Creates and starts a sub-agent session linked to the provided parent session.
     * Returns the created sub-agent session ID so callers can monitor status.
     */
    createAndRunSubAgent(
        parentSession: Session,
        instructions: string,
        activeSkill?: string,
        options: StartAgentOptions = {},
    ): string {
        const subSession = this.repository.createSession(parentSession.modelName, {}, parentSession.id, "agent");

        const prompt = activeSkill
            ? `${instructions}\n\nPreferred active skill: ${activeSkill}`
            : instructions;

        // One-shot consumer: provides one initial task message, then no further turns.
        let consumed = false;
        const oneShotIncomingRequestConsumer = (callback: (request: SessionRequest | undefined) => void): void => {
            if (consumed) {
                callback(undefined);
                return;
            }
            consumed = true;
            callback({
                type: "subagent_task",
                payload: prompt,
            });
        };

        const { processId } = this.startAgentForSession(subSession.id, oneShotIncomingRequestConsumer, options);

        logger.info({ parentSessionId: parentSession.id, subSessionId: subSession.id, processId }, 'Started sub-agent process');
        return String(subSession.id);
    }

    getSubAgentStatus(agentId: string): string {
        const sessionId = Number.parseInt(agentId, 10);
        if (Number.isNaN(sessionId)) {
            throw new Error(`Invalid sub-agent ID: ${agentId}`);
        }

        const subSession = this.repository.getSession(sessionId);
        if (!subSession) {
            throw new Error(`Sub-agent session with ID ${agentId} not found`);
        }

        const processId = this.processInstanceBySession.get(sessionId);
        if (!processId) {
            return subSession.status;
        }

        const container = this.getProcessStatus(processId);
        return container?.status ?? subSession.status;
    }

    listSubAgents(parentAgentId: string): string {
        const parentSessionId = Number.parseInt(parentAgentId, 10);
        if (Number.isNaN(parentSessionId)) {
            throw new Error(`Invalid parent agent ID: ${parentAgentId}`);
        }

        const subSessions = this.repository.getSubSessions(parentSessionId);
        let result = `| Sub-Agent ID | Status | Created At |\n|---|---|---|\n`;
        for (const subSession of subSessions) {
            result += `| ${subSession.id} | ${subSession.status} | ${new Date(subSession.createdAt).toLocaleString()} |\n`;
        }
        return result;
    }

    private buildAgentProcess(
        session: Session,
        incomingRequestConsumer: (callback: (request: SessionRequest | undefined) => void) => void,
        sessionEventTopic: Topic<AgentSessionEvent> = NullTopic as Topic<AgentSessionEvent>,
        reactEventTopic: Topic<ReActEvent> = NullTopic as Topic<ReActEvent>,
        summarizationConfig?: SummarizationPluginConfig,
        ralphIterations: number = 0,
        commandTopic?: Topic<AgentCommand>,
    ): AgentProcess {
        const process = new AgentProcess(
            this.workspace,
            session,
            this.repository,
            incomingRequestConsumer,
            sessionEventTopic,
            reactEventTopic,
            summarizationConfig,
            ralphIterations,
            commandTopic,
        );

        process.usePlugin(new MCPToolsPlugin(this.mcpClientManager));
        process.usePlugin(new SubAgentManagementPlugin(this, session));
        return process;
    }

    private serializeModelConfig(modelConfig: Record<string, unknown>): Record<string, string> {
        const serialized: Record<string, string> = {};
        for (const [key, value] of Object.entries(modelConfig)) {
            serialized[key] = typeof value === 'string' ? value : JSON.stringify(value);
        }
        return serialized;
    }
}
