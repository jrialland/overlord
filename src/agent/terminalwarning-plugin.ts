/**
 * This plugin modifies the graph :
 * At the end of the conversation, check if there are terminal warnings by calling TerminalTools.getWarningMessage().
 * If there are no warnings, do nothing, go to the end of the graph,
 * If there are warnings, add message to the agent state, and jump back to the graph node before the agent turn, so that the agent can react to the warning and adjust its plan if needed.
 *
 * This allows the agent to be aware of potential issues with its plan or actions, and adapt accordingly, improving its robustness and performance.
 */
import { AgentPlugin, type AgentState } from "./agent";
import { TerminalTools } from "../tools/terminal";
import type { Graph } from "./graph";



export class TerminalWarningPlugin implements AgentPlugin {
    name = "TerminalWarningPlugin"
    description = "Checks for terminal warnings after each turn and allows the agent to react to them.";

    constructor(private terminalTools: TerminalTools) {}
 
    async getGraph(state: AgentState, chain: PluginChain): Promise<Graph<AgentState>> {
        const wrappedGraph = await chain.doNextGetGraph();

        const graph = new Graph<AgentState>("terminal-warning");
        const startNode = wrappedGraph.getStartNode();
        
        graph.addSubgraphNode("inner", wrappedGraph);

        graph.addEdge(graph.START, "inner");
        
        graph.addConditionalEdge(
            "inner",
            (state: AgentState) => {
                const warningMessage = this.terminalTools.getWarningMessage();
                if (warningMessage) {
                    state.addMessage({ role: "system", content: `Terminal Warning: ${warningMessage}` });
                }
                return warningMessage ? "hasWarning" : "noWarning";
            },
            {
                hasWarning: "inner", // If there is a warning, go back to the inner graph to let the agent react to it
                noWarning: graph.END, // If there is no warning, go to the end of the graph
            }
        )

        graph.addEdge("inner", graph.END);

    }
}