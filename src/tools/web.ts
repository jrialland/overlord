
/**
 * 
 * Web Search / News Search / Fetch Web Content Tools for Overlord.
 * 
 * Web search features use the "ddgs" python package, which provides a unified interface to multiple search engines (Google, Bing, DuckDuckGo, etc.) and can bypass some of the restrictions of individual search engines.
 * Therefore, the Web Search tools are implemented as a python MCP server that uses the "ddgs" package to perform web searches and news searches.
 * 
 * The Web Search tools are provided through an MCP client for this server, therefore it requires python to be installed on the system for this functionality to be available. The MCP server is automatically set up in a temporary directory with a virtual environment to avoid dependency conflicts, and is started as a subprocess when the Web Search tools are accessed for the first time.
 * If the MCP server fails to start for any reason (e.g. python not installed, dependencies installation failure, runtime errors, etc.), the Web Search tools will simply not be available, but the rest of Overlord's functionality will work as normal.
 * 
 * The Fetch Web Content tool is implemented in Typescript using 'jsdom', '@mozilla/readability' & 'turndown', and does not depend on the python MCP server, so it is always available regardless of the MCP server status.
 * 
 */
import { spawnSync, which } from "bun";
import path from "path";
import os from "os";
import fs from "fs";
import { logger } from "../logging";
import { type Tool, type ToolSet } from "ai";

import {JSDOM, VirtualConsole} from "jsdom";
import { Defuddle, type DefuddleResponse } from 'defuddle/node';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from "zod";
import { error } from "console";

const pyproject = `
[project]
name = "overlord-webtools-mcp"
version = "0.1.0"
description = "A collection of web tools for Overlord"
requires-python = ">=3.10"
dependencies = [
    "ddgs",
    "fastmcp",
    "pydantic",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`;

const overlord_webtools_mcp_py = `
from typing import Annotated, Any, Literal
from pydantic import Field
from fastmcp import FastMCP
from ddgs import DDGS

mcp = FastMCP(
    name="overlord-webtools-mcp",
    instructions="Web search, Web News, Web Scraping"
)

ddgs_client = DDGS()

@mcp.tool
def web_search(
    query: Annotated[str, Field(description="The search query")],
    region: Annotated[str, Field(default="us-en", description="The region to search in, e.g. 'us-en' for United States English")],
    max_results: Annotated[int, Field(default=10, ge=1, le=100, description="Maximum number of results")]
) -> dict[str, Any]:
    """
        Perform a web search across multiple search engines.
    """
    try:
        results = ddgs_client.text(
            query = query,
            region = region,
            max_results = max_results,
            safesearch = "moderate",
            backend = "auto"
        )
        return {
            "results": results
        }
    except Exception as e:
        raise RuntimeError(f"Web search failed: {str(e)}")

@mcp.tool
def news_search(
    query: Annotated[str, Field(description="The news search query")],
    region: Annotated[str, Field(default="us-en", description="The region to search in, e.g. 'us-en' for United States English")],
    max_results: Annotated[int, Field(default=10, ge=1, le=100, description="Maximum number of results")],
    time_range: Annotated[Literal["day", "week", "month", "year"] | None, Field(default=None, description="The time range to search in, e.g. 'day', 'week', 'month', 'year'")]
) -> dict[str, Any]:
    """
    Search for news articles across multiple search engines.
    """
    try:
        results = ddgs_client.news(
            query = query,
            region = region,
            max_results = max_results,
            safesearch = "moderate",
            backend = "auto",
            timelimit = None if time_range is None else time_range[0]
        )
        return {
            "results": results
        }
    except Exception as e:
        raise RuntimeError(f"News search failed: {str(e)}")

def main():
    mcp.run(show_banner=False)

if __name__ == "__main__":
    main()
`;

async function getPythonPath(): Promise<string | undefined> {
    for (const exe of ["python3", "python"]) {
        const path = which(exe);
        if (path) {
            return path;
        }
    }
    return undefined;
}

interface PythonProjectInfo {
    interpreterPath: string;
    scriptPath: string;
    cwd: string;
}

export class WebTools {

    private mcpClient: Client | null = null;

    private attemptedInitialization = false;

    private pythonProjectDir: string

    constructor(private workspace: string, pythonProjectDir: string | undefined = undefined) {
        if (!pythonProjectDir) {
            this.pythonProjectDir = path.join(os.homedir(), ".config", "overlord", "overlord-webtools-mcp");
        } else {
            this.pythonProjectDir = pythonProjectDir;
        }
    }

    /**
     * Initialize the Python project for the web tools MCP server.
     * @returns The Python project information including interpreter path, script path, and working directory.
     */
    private async initializePythonProject(): Promise<PythonProjectInfo> {

        // Create the project directory and write the pyproject.toml and MCP server script files
        fs.mkdirSync(this.pythonProjectDir, { recursive: true });
        fs.writeFileSync(path.join(this.pythonProjectDir, "pyproject.toml"), pyproject);
        fs.writeFileSync(path.join(this.pythonProjectDir, "overlord_webtools_mcp.py"), overlord_webtools_mcp_py);

        const venvPath = path.join(this.pythonProjectDir, ".venv");
        const venvPythonPath = process.platform === "win32" ? path.join(venvPath, "Scripts", "python.exe") : path.join(venvPath, "bin", "python");

        // If venvPythonPath exists, we can assume the MCP server is already set up and skip the initialization
        if (!fs.existsSync(venvPythonPath)) {

            // Check if python is installed and get the path to the python executable
            const pythonPath = await getPythonPath();
            if (!pythonPath) {
                throw new Error("Python is not installed or not found in PATH. Web tools MCP server cannot be initialized.");
            }
            logger.info(`Using python executable at: ${pythonPath}`);

            // Create the virtual environment and install dependencies
            logger.info("Creating virtual environment for web tools MCP server...");
            const result = spawnSync({
                cmd: [pythonPath, "-m", "venv", venvPath],
                cwd: this.pythonProjectDir,
                stdout: "inherit",
                stderr: "inherit"
            });
            if (result.exitCode !== 0) {
                throw new Error(`Failed to create virtual environment. Exit code: ${result.exitCode}`);
            }

            // Install the MCP server dependencies using pip
            try {
                logger.info("Installing web tools MCP server dependencies...");
                const result = spawnSync({
                    cmd: [venvPythonPath, "-m", "pip", "install", "."],
                    cwd: this.pythonProjectDir,
                    stdout: "inherit",
                    stderr: "inherit"
                });
                if (result.exitCode !== 0) {
                    throw new Error(`Failed to install MCP server dependencies. Exit code: ${result.exitCode}`);
                }
            } catch (error) {
                console.error("An error occurred while installing MCP server dependencies:", error);
            }
        }
        // return The MCP server command
        return {
            interpreterPath: venvPythonPath,
            scriptPath: "overlord_webtools_mcp.py",
            cwd: this.pythonProjectDir
        };
    }

    private async mcpCall(toolName: string, args: Record<string, unknown>): Promise<string> {
        if (!this.mcpClient) {
            throw new Error("MCP client is not initialized");
        }
        try {
            const result = await this.mcpClient.callTool({ name: toolName, arguments: args });
            const contentItems = result.content as Array<{ type: string; text?: string }>;
            if (result.isError) {
                const errorContent = contentItems
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text)
                    .join('\n');
                throw new Error(`MCP tool execution failed: ${errorContent || 'Unknown error'}`);
            }
            const textContent = contentItems
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n');
            return textContent;
        } catch (error) {
            console.error(`An error occurred while calling MCP tool '${toolName}':`, error);
            throw error;
        }
    }

    private async startMcpServer(pythonProjectInfo: PythonProjectInfo): Promise<void> {

        const transport = new StdioClientTransport({
            command: pythonProjectInfo.interpreterPath,
            args: [pythonProjectInfo.scriptPath],
            cwd: pythonProjectInfo.cwd
        });

        let client = new Client({
            name: "overlord-webtools-client",
            version: "1.0.0"
        });
        await client.connect(transport);
        this.mcpClient = client;
    }

    async getToolSet(): Promise<ToolSet> {

        if (this.mcpClient === null && !this.attemptedInitialization) {
            this.attemptedInitialization = true;
            try {
                const py = await this.initializePythonProject();
                logger.info("Starting web tools MCP server...");
                await this.startMcpServer(py);
                logger.info("Web tools MCP server started and client connected successfully.");

            } catch (error) {
                logger.error({ error }, "Failed to initialize web tools MCP server:");
            }
        }

        let tools: ToolSet = {};

        if (this.mcpClient) {
            tools = {
                ...tools,
                "WebSearch": {
                    description: "Perform a web search across multiple search engines.",
                    inputSchema: z.object({
                        query: z.string().describe("The search query"),
                        region: z.string().default("us-en").describe("The region to search in, e.g. 'us-en' for United States English"),
                        max_results: z.number().int().min(1).max(100).default(10).describe("Maximum number of results")
                    }),
                    execute: async ({ query, region, max_results }) => this.mcpCall("web_search", { query, region, max_results })
                } as Tool,
                "NewsSearch": {
                    description: "Search for news articles across multiple search engines.",
                    inputSchema: z.object({
                        query: z.string().describe("The news search query"),
                        region: z.string().default("us-en").describe("The region to search in, e.g. 'us-en' for United States English"),
                        max_results: z.number().int().min(1).max(100).default(10).describe("Maximum number of results"),
                        time_range: z.string().nullable().describe("The time range to search in, e.g. 'day', 'week', 'month', 'year'")
                    }),
                    execute: async ({ query, region, max_results, time_range }) => this.mcpCall("news_search", { query, region, max_results, time_range })
                } as Tool
            };
        }

        // Add the FetchWebContent tool which is implemented in Typescript and does not depend on the MCP server
        tools = {
            ...tools,
            "FetchWebContent": {
                description: "Fetch and extract the main content of a web page, given its URL. The content is returned as text, with HTML tags removed.",
                inputSchema: z.object({
                    url: z.string().url().describe("The URL of the web page to fetch")
                }),
                execute: async ({ url }) => {
                    return await this.fetchWebContent(url);
                }
            } as Tool
        };

        return tools;
    }

    async fetchWebContent(url: string): Promise<string> {


        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, 15000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);


        if (!response.ok) {
            throw new Error(`HTTP Status ${response.status}`);
        }

        const MAX_BYTES = 1024 * 1024 * 5; // 5 MB limit

        const responseReader = response.body!.getReader();
        let received = 0;
        let chunks: Uint8Array[] = [];

        while (true) {
            const { done, value } = await responseReader.read();
            if (done) break;
            received += value.length;
            if (received > MAX_BYTES) {
                controller.abort();
                throw new Error("Response too large");
            }
            chunks.push(value);
        }
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        chunks.reduce((offset, chunk) => {
            combined.set(chunk, offset);
            return offset + chunk.length;
        }, 0);
        const html = new TextDecoder("utf-8").decode(combined);

        const virtualConsole = new VirtualConsole();
        virtualConsole.on("error", (msg) => {
            logger.warn(`jsdom error while parsing ${url}: ${msg}`);
        });

        const jsdom = new JSDOM(html, { virtualConsole });
        const result = await Defuddle(jsdom.window.document, url, { markdown: true });
        const content = (result.content ||'').trim();
        if(!content) {
            throw new Error("No content extracted from the web page");
        }
        return content
    }

}