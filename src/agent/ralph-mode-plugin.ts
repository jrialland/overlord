import type { AgentCommand } from "./types";
import type { AgentPlugin, AgentState, PluginChain } from "./agent";
import { Graph } from "./graph";

export const RALPH_PLUGIN_DATA_KEY = "ralph";

type RalphPluginData = {
    iterations: number;
    remainingRalphIterations: number;
};

const DEFAULT_RALPH_DATA: RalphPluginData = {
    iterations: 0,
    remainingRalphIterations: 0,
};

export class RalphModePlugin implements AgentPlugin {
    name = "RalphModePlugin";
    description = "Wraps the base graph in an outer loop for Ralph-mode iterations with fresh conversation resets.";

    constructor(private readonly initialIterations: number = 0) {}

    private readPluginData(state: AgentState): RalphPluginData {
        const raw = state.pluginData[RALPH_PLUGIN_DATA_KEY];
        if (!raw || typeof raw !== "object") {
            return { ...DEFAULT_RALPH_DATA };
        }
        return raw as RalphPluginData;
    }

    private writePluginData(state: AgentState, data: RalphPluginData): void {
        state.pluginData[RALPH_PLUGIN_DATA_KEY] = {
            iterations: data.iterations,
            remainingRalphIterations: data.remainingRalphIterations,
        };
    }

    private keepOnlyInitialSystemPrompt(state: AgentState): void {
        const initialSystemPrompt = state.firstSystemMessage;
        state.messages = initialSystemPrompt ? [{ ...initialSystemPrompt }] : [];
    }

    private prepareNextIteration(state: AgentState): void {
        const data = this.readPluginData(state);
        this.writePluginData(state, {
            iterations: data.iterations + 1,
            remainingRalphIterations: data.remainingRalphIterations - 1,
        });
        this.keepOnlyInitialSystemPrompt(state);
    }

    async beforeConversation(state: AgentState, chain: PluginChain): Promise<AgentState> {
        // Self-initialize pluginData on first call; once set, preserve existing values.
        if (!state.pluginData[RALPH_PLUGIN_DATA_KEY]) {
            this.writePluginData(state, {
                iterations: 0,
                remainingRalphIterations: Math.max(0, Math.floor(this.initialIterations)),
            });
        }
        return chain.doNextBeforeConversation(state);
    }

    async onCommand(state: AgentState, command: AgentCommand, chain: PluginChain): Promise<void> {
        if (command.type === 'set_ralph_iterations') {
            const data = this.readPluginData(state);
            this.writePluginData(state, {
                iterations: data.iterations,
                remainingRalphIterations: Math.max(0, Math.floor(command.value)),
            });
        }
        await chain.doNextOnCommand(state, command);
    }

    async getGraph(state: AgentState, chain: PluginChain): Promise<Graph<AgentState>> {
        if (!chain.doNextGetGraphAfter) {
            throw new Error("Plugin chain does not support graph wrapping delegation");
        }

        const wrappedGraph = await chain.doNextGetGraphAfter(state, this.name);

        const outerGraph = new Graph<AgentState>("RalphModeOuterGraph");
        outerGraph.addSubgraphNode("run_wrapped_graph", wrappedGraph);
        outerGraph.addNode("ralph_should_loop", async (currentState: AgentState) => {
            return currentState;
        });
        outerGraph.addNode("ralph_prepare_next_iteration", async (currentState: AgentState) => {
            this.prepareNextIteration(currentState);
            return currentState;
        });
        outerGraph.addEdge(outerGraph.START, "run_wrapped_graph");
        outerGraph.addEdge("run_wrapped_graph", "ralph_should_loop");
        outerGraph.addConditionalEdge(
            "ralph_should_loop",
            (currentState: AgentState) => this.readPluginData(currentState).remainingRalphIterations > 0 ? "loop" : "end",
            {
                loop: "ralph_prepare_next_iteration",
                end: outerGraph.END,
            }
        );
        outerGraph.addEdge("ralph_prepare_next_iteration", "run_wrapped_graph");

        return outerGraph;
    }
}
