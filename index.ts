import { createInterface } from "readline";
import * as path from "path";
import chalk from "chalk";
import { Command } from "commander";
import { AgentManager } from "./src/agent/manager";
import type { AgentSessionEvent } from "./src/agent/agent";
import type { ReActEvent } from "./src/agent/react";
import type { SessionRequest } from "./src/agent/types";
import { Bus } from "./src/bus";
import { DEFAULT_CONFIG_PATH, loadOverlordConfig, type OverlordSummarizationConfig } from "./src/config";
import { logger } from "./src/logging";

// Suppress framework logs — only model output should reach the terminal
logger.level = "error";

// ─── Argument parsing ────────────────────────────────────────────────────────

const REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
type ReasoningLevel = typeof REASONING_LEVELS[number];
const START_MODES = ['plan', 'agent'] as const;
type StartMode = typeof START_MODES[number];

interface CliOptions {
    workspace: string;
    model?: string;
    query: string | undefined;
    interactive: boolean;
    reasoning?: ReasoningLevel;
    startmode: StartMode;
    ralphIterations: number;
    summarization: OverlordSummarizationConfig;
}

function parseIntegerOption(optionName: string, value: unknown, minimum: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
        process.stderr.write(`Error: ${optionName} must be an integer >= ${minimum}\n`);
        process.exit(1);
    }
    return value;
}

function parsePercentageOption(optionName: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
        process.stderr.write(`Error: ${optionName} must be a number > 0 and <= 100\n`);
        process.exit(1);
    }
    return value;
}

function resolveSummarizationConfig(
    configFileValue: OverlordSummarizationConfig | undefined,
    cliValue: OverlordSummarizationConfig,
): OverlordSummarizationConfig | undefined {
    const merged: OverlordSummarizationConfig = {
        contextWindowSize: cliValue.contextWindowSize ?? configFileValue?.contextWindowSize,
        thresholdPercentage: cliValue.thresholdPercentage ?? configFileValue?.thresholdPercentage,
        minimumResponseReserveTokens:
            cliValue.minimumResponseReserveTokens ?? configFileValue?.minimumResponseReserveTokens,
    };

    const enabled =
        cliValue.enabled ??
        configFileValue?.enabled ??
        true; // on by default; set enabled: false in config or omit --summarize to disable

    return enabled ? merged : undefined;
}

/**
 * Parses CLI arguments and enforces required combinations.
 */
function parseArgs(argv: string[]): CliOptions {
    const program = new Command();

    program
        .name("overlord")
        .description("AI agent CLI")
        .option("--workspace <path>", "path to the workspace directory", process.cwd())
        .option("--model <model>", "model identifier to use (e.g. ollama/llama3, openai/gpt-4o)")
        .option("--query <text>", "query to run (required in non-interactive mode)")
        .option("--interactive", "start an interactive session", false)
        .option("--startmode <mode>", "initial agent mode: plan or agent", "plan")
        .option("--no-summarize", "disable automatic conversation summarization (enabled by default)")
        .option(
            "--summary-threshold <percentage>",
            "summarization trigger threshold as a percentage of the context window",
            (value: string) => Number.parseFloat(value),
        )
        .option(
            "--summary-reserve-tokens <count>",
            "reserve this many tokens for the next model response before triggering summarization",
            (value: string) => Number.parseInt(value, 10),
        )
        .option(
            "--summary-context-window <tokens>",
            "override the context window used by summarization decisions",
            (value: string) => Number.parseInt(value, 10),
        )
        .option(
            "--ralph-iterations <count>",
            "number of Ralph-mode iterations to run",
            (value: string) => Number.parseInt(value, 10),
            0,
        )
        .option(
            "--reasoning <level>",
            `reasoning effort level: ${REASONING_LEVELS.join(", ")}`,
        )
        .addHelpText("after", `
Examples:
  overlord --model ollama/llama3 --query "What is 2+2?"
  overlord --model openai/gpt-4o --interactive
  overlord --model openai/o3 --reasoning high --query "Solve this hard problem"
  overlord --model ollama/llama3 --summary-threshold 80 --query "Summarize this repository"
  overlord --model ollama/llama3 --no-summarize --query "Run without summarization"`)
        .parse(argv);

    const raw = program.opts<{
        workspace: string;
        model?: string;
        query?: string;
        interactive: boolean;
        reasoning?: string;
        startmode: string;
        summarize: boolean;
        summaryThreshold?: number;
        summaryReserveTokens?: number;
        summaryContextWindow?: number;
        ralphIterations: number;
    }>();

    if (raw.reasoning && !(REASONING_LEVELS as readonly string[]).includes(raw.reasoning)) {
        process.stderr.write(`Error: --reasoning must be one of: ${REASONING_LEVELS.join(", ")}\n`);
        process.exit(1);
    }

    if (!START_MODES.includes(raw.startmode as StartMode)) {
        process.stderr.write(`Error: --startmode must be one of: ${START_MODES.join(", ")}\n`);
        process.exit(1);
    }

    if (!Number.isFinite(raw.ralphIterations) || raw.ralphIterations < 0 || !Number.isInteger(raw.ralphIterations)) {
        process.stderr.write("Error: --ralph-iterations must be an integer >= 0\n");
        process.exit(1);
    }

    const summarization: OverlordSummarizationConfig = {
        enabled: raw.summarize ? undefined : false,
        thresholdPercentage:
            raw.summaryThreshold !== undefined
                ? parsePercentageOption("--summary-threshold", raw.summaryThreshold)
                : undefined,
        minimumResponseReserveTokens:
            raw.summaryReserveTokens !== undefined
                ? parseIntegerOption("--summary-reserve-tokens", raw.summaryReserveTokens, 1)
                : undefined,
        contextWindowSize:
            raw.summaryContextWindow !== undefined
                ? parseIntegerOption("--summary-context-window", raw.summaryContextWindow, 1)
                : undefined,
    };

    const opts: CliOptions = {
        workspace: path.resolve(raw.workspace),
        model: raw.model,
        query: raw.query,
        interactive: raw.interactive,
        reasoning: raw.reasoning as ReasoningLevel | undefined,
        startmode: raw.startmode as StartMode,
        ralphIterations: raw.ralphIterations,
        summarization,
    };

    if (!opts.interactive && !opts.query) {
        process.stderr.write(
            "Error: --query is required in non-interactive mode (or pass --interactive)\n",
        );
        program.help({ error: false });
        process.exit(1);
    }

    return opts;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Starts the CLI process in either one-shot or interactive mode.
 */
async function main() {
    const opts = parseArgs(process.argv);
    const fileConfig = await loadOverlordConfig();
    const selectedModel = opts.model ?? fileConfig.defaultModel;
    const selectedModelConfig = opts.model ? undefined : fileConfig.defaultModelConfig;
    const summarizationConfig = resolveSummarizationConfig(fileConfig.summarization, opts.summarization);
    const modelSource = opts.model ? "--model" : "defaultModel";

    if (!selectedModel) {
        process.stderr.write(
            `Error: no model configured. Pass --model <provider/model>, or set defaultModel in ${DEFAULT_CONFIG_PATH}\n`,
        );
        process.exit(1);
    }

    process.stdout.write(chalk.dim(`Using model: ${selectedModel} (source: ${modelSource})`) + "\n");

    // ── Request channel ──────────────────────────────────────────────────────
    // The Session pulls requests one at a time via a callback.  We bridge that
    // to a simple queue so the CLI can enqueue messages at will.

    let pendingCallback: ((req: SessionRequest) => void) | null = null;
    const requestQueue: SessionRequest[] = [];

    const enqueueRequest = (text: string) => {
        const req: SessionRequest = { type: "user_message", payload: text };
        if (pendingCallback) {
            const cb = pendingCallback;
            pendingCallback = null;
            cb(req);
        } else {
            requestQueue.push(req);
        }
    };

    const incomingRequestConsumer = (callback: (req: SessionRequest) => void) => {
        if (requestQueue.length > 0) {
            callback(requestQueue.shift()!);
        } else {
            // Session pulls exactly one request at a time via this callback.
            pendingCallback = callback;
        }
    };

    // ── Turn-completion signal ────────────────────────────────────────────────
    // We create a fresh Promise before each turn and resolve it from inside
    // the event handler so the CLI can await the turn finishing.

    let onTurnComplete: (() => void) | null = null;

    const waitForTurn = (): Promise<void> =>
        new Promise<void>((resolve) => {
            onTurnComplete = resolve;
        });

    // ── Output handler ───────────────────────────────────────────────────────

    let atLineStart = true;
    let turnStarted = false;

    const markTurnStarted = () => {
        if (turnStarted) return;
        if (!atLineStart) process.stdout.write("\n");
        process.stdout.write(chalk.dim.blue("[inference started]") + "\n");
        atLineStart = true;
        turnStarted = true;
    };

    const markTurnEnded = () => {
        turnStarted = false;
    };

    type CliEvent = AgentSessionEvent | ReActEvent;

    const handleEvent = async (event: CliEvent) => {
        switch (event.type) {
            case "reasoning_start": {
                markTurnStarted();
                process.stdout.write(chalk.dim.cyan("[reasoning]") + "\n");
                atLineStart = true;
                break;
            }
            case "reasoning_chunk": {
                const text = event.text;
                process.stdout.write(chalk.cyan(text));
                atLineStart = text.endsWith("\n");
                break;
            }
            case "reasoning_end": {
                if (!atLineStart) process.stdout.write("\n");
                process.stdout.write(chalk.dim.cyan("[/reasoning]") + "\n");
                atLineStart = true;
                break;
            }
            case "response_start": {
                markTurnStarted();
                process.stdout.write(chalk.dim.green("[response]") + "\n");
                atLineStart = true;
                break;
            }
            case "response_chunk": {
                const text = event.text;
                process.stdout.write(chalk.green(text));
                atLineStart = text.endsWith("\n");
                break;
            }
            case "response_end": {
                if (!atLineStart) process.stdout.write("\n");
                process.stdout.write(chalk.dim.green("[/response]") + "\n");
                atLineStart = true;
                break;
            }
            case "tool_call_start": {
                markTurnStarted();
                const toolName = event.toolName;
                if (!atLineStart) process.stdout.write("\n");
                // Dim indicator so tool activity is visible but unobtrusive
                process.stdout.write(" 🛠️ " + chalk.dim(`${toolName}(${JSON.stringify(event.input)})`) + "\n");
                atLineStart = true;
                break;
            }
            case "session_turn_complete": {
                if (!atLineStart) process.stdout.write("\n");
                atLineStart = true;
                markTurnEnded();
                onTurnComplete?.();
                onTurnComplete = null;
                break;
            }
            case "session_error": {
                if (!atLineStart) process.stdout.write("\n");
                process.stderr.write(chalk.red(`Error: ${event.error}`) + "\n");
                atLineStart = true;
                markTurnEnded();
                onTurnComplete?.();
                onTurnComplete = null;
                break;
            }
            case "tool_call_finish":
            case "step_finish":
            case "structured_output":
            case "model_response":
            case "session_fatal_error": {
                break;
            }
            default: {
                const _exhaustive: never = event;
                void _exhaustive;
            }
        }
    };

    // ── Start the agent process through AgentManager ─────────────────────────

    const manager = new AgentManager(opts.workspace);

    if (fileConfig.mcp) {
        await manager.connectMcp(fileConfig.mcp);
    }

    const bus = new Bus();
    const sessionEventTopic = bus.getTopic<AgentSessionEvent>("cli.session.events");
    const reactEventTopic = bus.getTopic<ReActEvent>("cli.react.events");

    sessionEventTopic.subscribe(async (event) => {
        await handleEvent(event);
    });

    reactEventTopic.subscribe(async (event) => {
        await handleEvent(event);
    });

    const modelConfig = {
        ...(selectedModelConfig ?? {}),
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    };

    manager.createAndRunAgent(
        selectedModel,
        incomingRequestConsumer,
        modelConfig,
        {
            sessionEventTopic,
            reactEventTopic,
            startMode: opts.startmode,
            ralphIterations: opts.interactive ? 0 : opts.ralphIterations,
            summarizationConfig,
        },
    );

    // ── Non-interactive mode ─────────────────────────────────────────────────

    if (!opts.interactive) {
        const done = waitForTurn();
        markTurnStarted();
        enqueueRequest(opts.query!);
        await done;
        process.exit(0);
    }

    // ── Interactive mode ─────────────────────────────────────────────────────

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let rlClosed = false;
    rl.on("close", () => {
        rlClosed = true;
    });

    // Wraps rl.question() as a Promise that returns null on Ctrl-D
    const getLine = (prompt: string): Promise<string | null> =>
        new Promise((resolve) => {
            if (rlClosed) {
                resolve(null);
                return;
            }
            rl.question(prompt, (line) => resolve(line));
            rl.once("close", () => resolve(null));
        });

    // If an initial --query was also provided in interactive mode, run it first
    if (opts.query) {
        process.stdout.write(chalk.dim(`(initial query: ${opts.query})`) + "\n");
        const done = waitForTurn();
        markTurnStarted();
        enqueueRequest(opts.query);
        await done;
    }

    while (true) {
        const line = await getLine("\n> ");
        if (line === null) break; // Ctrl-D / EOF

        const text = line.trim();
        if (!text) continue;

        const done = waitForTurn();
        markTurnStarted();
        enqueueRequest(text);
        await done;
    }

    process.stdout.write("\nGoodbye!\n");
    rl.close();
    process.exit(0);
}

main().catch((err: unknown) => {
    process.stderr.write(chalk.red(`Unexpected error: ${err}`) + "\n");
    process.exit(1);
});