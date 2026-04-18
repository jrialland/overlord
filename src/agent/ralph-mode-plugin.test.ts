import { describe, expect, it } from "bun:test";
import { AgentState, type PluginChain } from "./agent";
import {
    RalphModePlugin,
    RALPH_PLUGIN_DATA_KEY,
} from "./ralph-mode-plugin";
import { Graph } from "./graph";

function createMockChain(state: AgentState): PluginChain {
    const wrappedGraph = new Graph<AgentState>("WrappedGraphForTest");
    wrappedGraph.addNode("do_work", async (currentState: AgentState) => {
        currentState.messages.push({ role: "assistant", content: "work-done" });
        return currentState;
    });
    wrappedGraph.addEdge(wrappedGraph.START, "do_work");
    wrappedGraph.addEdge("do_work", wrappedGraph.END);

    return {
        doNextBeforeConversation: async (s: AgentState) => s,
        doNextAfterConversation: async (s: AgentState) => s,
        doNextBeforeTurn: async (s: AgentState) => s,
        doNextAfterTurn: async (s: AgentState) => s,
        doNextGetToolSet: async () => ({}),
        doNextGetGraph: async () => wrappedGraph,
        doNextGetGraphAfter: async () => wrappedGraph,
        stateGetter: () => state,
    };
}

describe("RalphModePlugin", () => {
    it("wraps graph execution, updates counters, and loops with fresh initial-system-only conversation", async () => {
        const plugin = new RalphModePlugin();
        const state = new AgentState();
        state.messages = [
            { role: "system", content: "Initial system prompt" },
            { role: "user", content: "Task" },
        ];
        state.pluginData[RALPH_PLUGIN_DATA_KEY] = {
            iterations: 0,
            remainingRalphIterations: 2,
        };

        const chain = createMockChain(state);

        await plugin.beforeConversation(state, chain);
        const graph = await plugin.getGraph(state, chain);
        const finalState = await graph.execute(state);

        const data = finalState.pluginData[RALPH_PLUGIN_DATA_KEY] as {
            iterations: number;
            remainingRalphIterations: number;
        };
        expect(data.iterations).toBe(2);
        expect(data.remainingRalphIterations).toBe(0);
        expect(finalState.messages).toHaveLength(2);
        expect(finalState.messages[0]?.role).toBe("system");
        expect(String(finalState.messages[0]?.content)).toContain("Initial system prompt");
        expect(finalState.messages[1]?.role).toBe("assistant");
        expect(String(finalState.messages[1]?.content)).toContain("work-done");
    });

    it("does not expose any control tools to the agent", async () => {
        const plugin = new RalphModePlugin();
        const state = new AgentState();
        const chain = createMockChain(state);

        expect(plugin.getToolSet).toBeUndefined();
        const inheritedTools = await chain.doNextGetToolSet();
        expect(inheritedTools).toEqual({});
    });
});
