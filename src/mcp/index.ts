import type { MCPServerConfig, MCPConfig, MCPtool } from './types';
import type { Tool, ToolSet } from "ai";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../logging';
import { z, type ZodTypeAny } from 'zod';

type MCPPropertySchema = {
  type?: string;
  description?: string;
  nullable?: boolean;
  default?: unknown;
  items?: unknown;
  properties?: Record<string, unknown>;
  required?: string[];
  enum?: unknown[];
};

type ZodLiteralValue = string | number | bigint | boolean | null | undefined;

/**
 * Manages MCP server connections and exposes remote tools as AI SDK ToolSet entries.
 */
export class MCPClientManager {

  private clients = new Map<string, Client>();
  private tools = new Map<string, MCPtool[]>();
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  /**
   * Connects all configured MCP servers and loads their tool metadata.
   */
  async connect(config: MCPConfig): Promise<void> {
    for (const [name, serverConfig] of Object.entries(config)) {
      try {
        await this.connectServer(name, serverConfig);
      } catch (error) {
        logger.error({ server: name, error: String(error) }, 'Failed to connect to MCP server');
      }
    }
  }

  /**
   * Connects a single MCP server via stdio, sse, or streamable HTTP transport.
   */
  async connectServer(name: string, config: MCPServerConfig): Promise<void> {
    logger.info({ server: name, transport: config.transport }, 'Connecting to MCP server');

    let transport;

    if (config.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: config.command!,
        args: config.args || [],
        env: config.env,
        cwd: config.cwd || this.workspace
      });
    } else if (config.transport === 'sse') {
      transport = new SSEClientTransport(new URL(config.url!), {
        requestInit: {
          headers: config.headers || {}
        }
      });
    } else if (["http", "streamableHttp"].includes(config.transport)) {
      transport = new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: {
          headers: config.headers || {}
        }
      });
    }
    else {
      throw new Error(`Unknown transport: ${config.transport}`);
    }

    const client = new Client({
      name: `overlord-${name}`,
      version: '1.0.0'
    });

    await client.connect(transport);
    this.clients.set(name, client);

    const listToolsResult = await client.listTools();
    const serverTools = listToolsResult.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parameters: {
        type: 'object',
        properties: tool.inputSchema?.properties || {},
        required: (tool.inputSchema?.required as string[]) || []
      }
    }));

    this.tools.set(name, serverTools);

    logger.info({ server: name, toolCount: serverTools.length }, 'Connected to MCP server');
  }

  /**
   * Closes all MCP clients and clears cached tool metadata.
   */
  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
        logger.info({ server: name }, 'Disconnected from MCP server');
      } catch (error) {
        logger.error({ server: name, error: String(error) }, 'Error disconnecting from MCP server');
      }
    }
    this.clients.clear();
    this.tools.clear();
  }

  /**
   * Returns all loaded MCP tools converted into AI SDK ToolSet entries.
   */
  getToolSet(): ToolSet {
    const toolSet: ToolSet = {};
    for (const [serverName, serverTools] of this.tools) {
      for (const mcpTool of serverTools) {
        const namedTool = this.convertToTool(serverName, mcpTool);
        Object.assign(toolSet, namedTool);
      }
    }
    return toolSet;
  }

  /**
   * Executes a named tool on a connected MCP server.
   */
  async callTool(serverName: string, toolName: string, args: unknown): Promise<unknown> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    logger.debug({ server: serverName, tool: toolName, args }, 'Calling MCP tool');

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args as Record<string, unknown>
      });

      const contentItems = result.content as Array<{ type: string; text?: string }>;

      if (result.isError) {
        const errorContent = contentItems
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        throw new Error(`Tool execution failed: ${errorContent || 'Unknown error'}`);
      }

      const textContent = contentItems
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      if (textContent) {
        // Prefer JSON when possible so downstream callers receive structured data.
        try {
          return JSON.parse(textContent);
        } catch {
          return textContent;
        }
      }

      return result.content;
    } catch (error) {
      logger.error({ server: serverName, tool: toolName, error: String(error) }, 'MCP tool call failed');
      throw error;
    }
  }

  /**
   * Converts a discovered MCP tool into an executable AI SDK tool.
   */
  private convertToTool(serverName: string, mcpTool: MCPtool): Record<string, Tool> {
    const inputSchema = this.buildToolInputSchema(mcpTool);

    return {
      [`${serverName}:${mcpTool.name}`]: {
        description: `[${serverName}] ${mcpTool.description}`,
        inputSchema,
        execute: async (args: unknown) => {
          return this.callTool(serverName, mcpTool.name, args);
        }
      } as Tool
    };
  }

  /**
   * Builds a permissive Zod schema from MCP JSON-schema-like input definitions.
   */
  private buildToolInputSchema(mcpTool: MCPtool): z.ZodObject<Record<string, ZodTypeAny>> {
    const required = new Set(mcpTool.parameters.required ?? []);
    const shape: Record<string, ZodTypeAny> = {};

    for (const [key, value] of Object.entries(mcpTool.parameters.properties ?? {})) {
      shape[key] = this.schemaToZod(value as MCPPropertySchema, required.has(key));
    }

    // Allow extra fields because MCP servers sometimes accept provider-specific properties
    // beyond the simplified schema surface returned by listTools.
    return z.object(shape).loose();
  }

  /**
   * Applies metadata wrappers (description/optional/default/nullable) to a base schema.
   */
  private schemaToZod(schema: MCPPropertySchema, isRequired: boolean): ZodTypeAny {
    let zodSchema = this.baseSchemaToZod(schema);

    if (schema.description) {
      zodSchema = zodSchema.describe(schema.description);
    }

    if (schema.nullable) {
      zodSchema = zodSchema.nullable();
    }

    if (!isRequired) {
      zodSchema = zodSchema.optional();
    }

    if (schema.default !== undefined) {
      zodSchema = zodSchema.default(schema.default);
    }

    return zodSchema;
  }

  /**
   * Converts MCP primitive/object/array schema fragments to Zod.
   */
  private baseSchemaToZod(schema: MCPPropertySchema): ZodTypeAny {
    if (schema.enum && schema.enum.length > 0) {
      const enumValues = schema.enum.filter((value): value is ZodLiteralValue => {
        return value === null || ['string', 'number', 'bigint', 'boolean', 'undefined'].includes(typeof value);
      });

      if (enumValues.length === 1) {
        return z.literal(enumValues[0]);
      }

      if (enumValues.length > 1) {
        const literals = enumValues.map((value) => z.literal(value)) as [
          z.ZodLiteral<ZodLiteralValue>,
          z.ZodLiteral<ZodLiteralValue>,
          ...z.ZodLiteral<ZodLiteralValue>[]
        ];
        return z.union(literals);
      }
    }

    switch (schema.type) {
      case 'boolean':
        return z.boolean();
      case 'number':
        return z.number();
      case 'integer':
        return z.number().int();
      case 'array':
        return z.array(this.baseSchemaToZod((schema.items as MCPPropertySchema | undefined) ?? { type: 'string' }));
      case 'object': {
        const nestedRequired = new Set(schema.required ?? []);
        const nestedShape: Record<string, ZodTypeAny> = {};
        for (const [key, value] of Object.entries(schema.properties ?? {})) {
          nestedShape[key] = this.schemaToZod(value as MCPPropertySchema, nestedRequired.has(key));
        }
        return z.object(nestedShape).loose();
      }
      case 'string':
      default:
        return z.string();
    }
  }
}