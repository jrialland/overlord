/**
 * MCP server configuration
 */
export interface MCPServerConfig {
  /** Transport mechanism used to connect to the MCP server. */
  transport: 'stdio' | 'sse' | 'http' | 'streamableHttp';
  // Stdio options
  /** Executable name/path for stdio transport. */
  command?: string;
  /** Command-line arguments for stdio transport. */
  args?: string[];
  /** Environment variables passed to the stdio process. */
  env?: Record<string, string>;
  /** Working directory for stdio process startup. */
  cwd?: string;
  // HTTP options
  /** Endpoint URL for SSE or HTTP-based transports. */
  url?: string;
  /** Optional request headers for HTTP-based transports. */
  headers?: Record<string, string>;
}

/**
 * Named MCP server configuration map keyed by server id.
 */
export type MCPConfig = {[key: string]: MCPServerConfig};

/**
 * MCP tool definition (from server)
 */
export interface MCPtool {
  /** Tool name as exposed by the MCP server. */
  name: string;
  /** Human-readable tool description. */
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Abstract MCP client contract used by higher-level session code.
 */
export interface MCPClient {
  /** Establishes a connection to the configured MCP server. */
  connect(): Promise<void>;
  /** Closes the connection and releases resources. */
  disconnect(): Promise<void>;
  /** Lists available tools exposed by the server. */
  listTools(): Promise<MCPtool[]>;
  /** Executes one tool call with JSON-serializable arguments. */
  callTool(name: string, args: unknown): Promise<unknown>;
}
