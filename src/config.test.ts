import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "bun:test";
import { loadOverlordConfig, parseOverlordConfig } from "./config";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("Overlord config", () => {
    it("parses default model and model config", () => {
        const config = parseOverlordConfig(
            `{
                defaultModel: 'ollama/gemma4:26b',
                defaultModelConfig: {
                    timeout: 30000,
                    retries: 2,
                    providerOptions: {
                        ollama: {
                            think: true,
                        },
                    },
                },
            }`,
            "test-default-model.json",
        );

        expect(config.defaultModel).toBe("ollama/gemma4:26b");
        expect(config.defaultModelConfig).toEqual({
            timeout: 30000,
            retries: 2,
            providerOptions: {
                ollama: {
                    think: true,
                },
            },
        });
    });

    it("parses summarization configuration", () => {
        const config = parseOverlordConfig(
            `{
                summarization: {
                    enabled: true,
                    contextWindowSize: 65536,
                    thresholdPercentage: 82,
                    minimumResponseReserveTokens: 4096,
                },
            }`,
            "test-summarization-config.json",
        );

        expect(config.summarization).toEqual({
            enabled: true,
            contextWindowSize: 65536,
            thresholdPercentage: 82,
            minimumResponseReserveTokens: 4096,
        });
    });

    it("parses MCP configuration from JSON5", () => {
        const config = parseOverlordConfig(
            `{
                // comments and trailing commas are allowed
                mcp: {
                    local_tools: {
                        transport: 'stdio',
                        command: 'node',
                        args: ['server.js'],
                    },
                    remote_tools: {
                        transport: 'streamableHttp',
                        url: 'https://example.test/mcp',
                        headers: {
                            Authorization: 'Bearer token',
                        },
                    },
                },
            }`,
            "test-config.json",
        );

        expect(config.mcp).toEqual({
            local_tools: {
                transport: "stdio",
                command: "node",
                args: ["server.js"],
            },
            remote_tools: {
                transport: "streamableHttp",
                url: "https://example.test/mcp",
                headers: {
                    Authorization: "Bearer token",
                },
            },
        });
    });

    it("returns an empty object when the config file is missing", async () => {
        const missingPath = path.join(os.tmpdir(), `overlord-missing-${crypto.randomUUID()}.json`);
        await expect(loadOverlordConfig(missingPath)).resolves.toEqual({});
    });

    it("rejects invalid MCP transport configuration", () => {
        try {
            parseOverlordConfig(
                `{
                    mcp: {
                        broken: {
                            transport: 'stdio',
                        },
                    },
                }`,
                "invalid-config.json",
            );
            throw new Error("Expected parseOverlordConfig to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain("stdio transport requires a");
        }
    });

    it("rejects non-string defaultModel values", () => {
        expect(() =>
            parseOverlordConfig(
                `{
                    defaultModel: 123,
                }`,
                "invalid-default-model.json",
            ),
        ).toThrow("Invalid Overlord config");
    });

    it("rejects invalid summarization thresholds", () => {
        expect(() =>
            parseOverlordConfig(
                `{
                    summarization: {
                        thresholdPercentage: 101,
                    },
                }`,
                "invalid-summarization.json",
            ),
        ).toThrow("Invalid Overlord config");
    });

    it("loads config from disk", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlord-config-"));
        tempDirs.push(tempDir);

        const configPath = path.join(tempDir, "overlord.json");
        fs.writeFileSync(
            configPath,
            `{
                mcp: {
                    example: {
                        transport: 'sse',
                        url: 'https://example.test/sse',
                    },
                },
            }`,
            "utf-8",
        );

        await expect(loadOverlordConfig(configPath)).resolves.toEqual({
            mcp: {
                example: {
                    transport: "sse",
                    url: "https://example.test/sse",
                },
            },
        });
    });
});