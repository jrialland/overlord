import fs from "fs";
import os from "os";
import path from "path";
import JSON5 from "json5";
import { z } from "zod";
import type { MCPConfig } from "./mcp/types";

const summarizationConfigSchema = z.object({
    enabled: z.boolean().optional(),
    contextWindowSize: z.number().int().positive().optional(),
    thresholdPercentage: z.number().positive().max(100).optional(),
    minimumResponseReserveTokens: z.number().int().positive().optional(),
}).strict();

const mcpServerConfigSchema = z.object({
    transport: z.enum(["stdio", "sse", "http", "streamableHttp"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
}).superRefine((value, context) => {
    if (value.transport === "stdio" && !value.command) {
        context.addIssue({
            code: "custom",
            message: 'stdio transport requires a "command" field',
            path: ["command"],
        });
    }

    if (value.transport !== "stdio" && !value.url) {
        context.addIssue({
            code: "custom",
            message: `${value.transport} transport requires a "url" field`,
            path: ["url"],
        });
    }
});

const overlordConfigSchema = z.object({
    mcp: z.record(z.string(), mcpServerConfigSchema).optional(),
    defaultModel: z.string().optional(),
    defaultModelConfig: z.record(z.string(), z.unknown()).optional(),
    summarization: summarizationConfigSchema.optional(),
}).loose();

export type OverlordSummarizationConfig = z.infer<typeof summarizationConfigSchema>;

export type OverlordConfig = {
    mcp?: MCPConfig;
    defaultModel?: string;
    defaultModelConfig?: Record<string, unknown>;
    summarization?: OverlordSummarizationConfig;
};

/** Default configuration path used by the CLI at startup. */
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "overlord", "overlord.json");

/**
 * Parses one Overlord configuration file expressed in JSON5.
 *
 * The file is future-proofed: unknown top-level keys are allowed. The CLI currently
 * consumes `mcp`, `defaultModel`, `defaultModelConfig`, and `summarization`.
 */
export function parseOverlordConfig(configText: string, filePath: string): OverlordConfig {
    let rawConfig: unknown;

    try {
        rawConfig = JSON5.parse(configText);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse Overlord config at ${filePath}: ${message}`, {
            cause: error,
        });
    }

    const parsed = overlordConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
        throw new Error(`Invalid Overlord config at ${filePath}: ${parsed.error.message}`);
    }

    return parsed.data;
}

/**
 * Loads the default Overlord config file if present.
 * Missing config files are treated as an empty configuration.
 */
export async function loadOverlordConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<OverlordConfig> {
    if (!fs.existsSync(configPath)) {
        return {};
    }

    const stats = await fs.promises.stat(configPath);
    if (!stats.isFile()) {
        throw new Error(`Overlord config path is not a file: ${configPath}`);
    }

    const configText = await fs.promises.readFile(configPath, "utf-8");
    return parseOverlordConfig(configText, configPath);
}