import type { ToolSet } from "ai";
import { MCPClientManager } from "../mcp";
import type { AgentPlugin } from "./agent";

/**
 * Injects MCP-discovered tools into an agent's available toolset.
 *
 * This plugin isolates MCP concerns from process/session orchestration.
 */
export class MCPToolsPlugin implements AgentPlugin {
    name = "MCPToolsPlugin";
    description = "Adds tools provided by connected MCP servers.";

    constructor(private readonly mcpClientManager: MCPClientManager) {}

    async getToolSet(_state: unknown, chain: { doNextGetToolSet(): Promise<ToolSet> }): Promise<ToolSet> {
        const toolSet = await chain.doNextGetToolSet();
        return {
            ...toolSet,
            ...this.mcpClientManager.getToolSet(),
        };
    }
}
