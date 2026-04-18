/**
 * This plugin reminds the agent to check for sub-agents at the end of each turn, 
 * So it prevents an agent to spawn sub-agents and forget about them
 */

import { AgentPlugin, type AgentState, type PluginChain} from "./agent";
import { TerminalTools } from "../tools/terminal";
import { Graph } from "./graph";
import type { AgentManager } from "./manager";

export class SubAgentsWarningPlugin implements AgentPlugin {
    name = "SubAgentsWarningPlugin"
    description = "Warns the agent about potential sub-agents at the end of each turn.";

    constructor(private agentManager: AgentManager) { }

    async getGraph(state: AgentState, chain: PluginChain): Promise<Graph<AgentState>> {
        const wrappedGraph = await chain.doNextGetGraph();
        const graph = new Graph<AgentState>("sub-agents-warning");
        const startNode = wrappedGraph.getStartNode();
        graph.addSubgraphNode("inner", wrappedGraph);
        graph.addEdge(graph.START, "inner");
        graph.addConditionalEdge(
            "inner",
            (state: AgentState) => {
                const hasSubAgents = this.agentManager.hasActiveSubAgents(state.sessionId);
                if (hasSubAgents) {
                    state.addMessage({ role: "system", content: `Warning: There are active sub-agents ! Use the ListSubAgents tool to check their status.` });
                }
                return hasSubAgents ? "hasSubAgents" : "noSubAgents";
            },
            {
                hasSubAgents: "inner", // If there are sub-agents, go back to the inner graph to let the agent react to it
                noSubAgents: graph.END, // If there are no sub-agents, go to the end of the graph
            }
        )
        graph.addEdge("inner", graph.END);
        return graph;
    }
}
