/**
 * Terminal tools for executing shell commands and managing processes.
 * These tools allow you to run commands, capture their output, and handle errors effectively.
 * They are designed to be used within the context of an AI agent that needs to interact with the system's terminal.
 */

import type { Tool, ToolSet } from "ai";
import { randomUUID } from "crypto";
import { spawn, spawnSync } from "child_process";
import path from "path";
import { z } from "zod";

interface InterpreterInfo {
    type: string;
    shell: string;
    comment: string;
    args: string[];
}

interface TerminalSession {
    id: string;
    interpreter: InterpreterInfo;
    process: ReturnType<typeof spawn>;
    outputBuffer: string;
    errorBuffer: string;
    outputCursor: number;
    errorCursor: number;
    closed: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    createdAt: number;
    lastUsedAt: number;
    lastCommand: string | null;
    status: 'idle' | 'running';
    commandStartedAt: number | null;
}

interface TerminalToolsOptions {
    maxSessions?: number;
    idleTimeoutMs?: number;
    watchdogIntervalMs?: number;
}

export class TerminalTools {

    private readonly sessions = new Map<string, TerminalSession>();

    private readonly maxBufferedChars = 128000;

    private readonly workspace: string;

    private readonly maxSessions: number;

    private readonly idleTimeoutMs: number;

    private readonly watchdogIntervalMs: number;

    private readonly watchdogHandle: ReturnType<typeof setInterval>;

    private lastSessionId: string | undefined;

    constructor(workspace: string, options: TerminalToolsOptions = {}) {
        this.workspace = path.resolve(workspace);
        this.maxSessions = options.maxSessions ?? 5;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
        this.watchdogIntervalMs = options.watchdogIntervalMs ?? 30 * 1000;

        // Keep long-lived agent processes healthy by pruning stale or already-closed sessions.
        this.watchdogHandle = setInterval(() => {
            void this.pruneUnusedSessions();
        }, this.watchdogIntervalMs);
        this.watchdogHandle.unref?.();
    }

    /**
     * Detects an available interactive shell and returns startup metadata.
     */
    private static detectInterpreter(): InterpreterInfo {
        // On Windows, use 'pwsh.exe' or 'powershell.exe' or 'cmd.exe'. On Unix-like systems, use '/bin/bash' or '/bin/sh'.
        if (process.platform === 'win32') {
            for (const shell of ['pwsh.exe', 'powershell.exe', 'cmd.exe']) {
                const probeArgs = shell === 'cmd.exe' ? ['/c', 'ver'] : ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'];
                const probe = spawnSync(shell, probeArgs, { stdio: 'ignore' });
                if (probe.status === 0) {
                    const isCmd = shell === 'cmd.exe';
                    return {
                        type: 'windows',
                        shell,
                        comment: isCmd
                            ? "Use cmd.exe syntax. Do not use PowerShell-specific features."
                            : "Use PowerShell syntax only. Do not assume Unix-like shell features are available.",
                        args: isCmd ? ['/Q', '/K'] : ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-']
                    };
                }
            }
            throw new Error('No suitable shell found on Windows. Please install PowerShell or use cmd.exe.');
        } else {
            for (const shell of ['/bin/bash', '/bin/sh']) {
                const probe = spawnSync(shell, ['-lc', 'echo ok'], { stdio: 'ignore' });
                if (probe.status === 0) {
                    return {
                        type: 'posix',
                        shell,
                        comment: "Use Unix-like shell syntax.",
                        args: ['-i']
                    };
                }
            }
            throw new Error('No suitable shell found on Unix-like system. Expected /bin/bash or /bin/sh.');
        }
    }

    /**
     * Enforces a bounded in-memory buffer for terminal output streams.
     */
    private trimBuffer(value: string): string {
        if (value.length <= this.maxBufferedChars) {
            return value;
        }
        return value.slice(value.length - this.maxBufferedChars);
    }

    /**
     * Returns a tracked session or throws if the id is unknown.
     */
    private getSession(sessionId: string): TerminalSession {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Terminal session not found: ${sessionId}`);
        }
        return session;
    }

    /**
     * Marks a session as recently used and updates implicit-session routing.
     */
    private markSessionUsed(session: TerminalSession): void {
        session.lastUsedAt = Date.now();
        this.lastSessionId = session.id;
    }

    /**
     * Reaps closed or idle sessions to cap resource growth in long-lived processes.
     */
    private async pruneUnusedSessions(): Promise<void> {
        const now = Date.now();
        for (const [id, session] of this.sessions.entries()) {
            if (session.closed || now - session.lastUsedAt > this.idleTimeoutMs) {
                if (this.sessions.has(id)) {
                    await this.killTerminal(id);
                }
            }
        }
    }

    /**
     * Ensures new session creation will not exceed configured capacity.
     */
    private async ensureSessionCapacity(): Promise<void> {
        await this.pruneUnusedSessions();
        if (this.sessions.size >= this.maxSessions) {
            throw new Error(`Maximum number of terminal sessions reached (${this.maxSessions}). Kill unused sessions before creating a new one.`);
        }
    }

    /**
     * Resolves an existing session (explicit or last-used) or creates a new one.
     */
    private async getOrCreateSession(sessionId?: string): Promise<TerminalSession> {
        const effectiveSessionId = sessionId ?? this.lastSessionId;
        if (effectiveSessionId) {
            const existing = this.sessions.get(effectiveSessionId);
            if (existing && !existing.closed) {
                this.markSessionUsed(existing);
                return existing;
            }
        }

        const createdId = await this.createTerminal();
        const created = this.getSession(createdId);
        this.markSessionUsed(created);
        return created;
    }

    /**
     * Creates a long-lived interactive shell session bound to the workspace directory.
     */
    async createTerminal(): Promise<string> {
        await this.ensureSessionCapacity();

        const interpreter = TerminalTools.detectInterpreter();
        const proc = spawn(interpreter.shell, interpreter.args, {
            cwd: this.workspace,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
        });

        const id = randomUUID();
        const now = Date.now();
        const session: TerminalSession = {
            id,
            interpreter,
            process: proc,
            outputBuffer: '',
            errorBuffer: '',
            outputCursor: 0,
            errorCursor: 0,
            closed: false,
            exitCode: null,
            signal: null,
            createdAt: now,
            lastUsedAt: now,
            lastCommand: null,
            status: 'idle',
            commandStartedAt: null,
        };

        proc.stdout?.on('data', (chunk: Buffer | string) => {
            session.outputBuffer = this.trimBuffer(session.outputBuffer + chunk.toString());
            session.outputCursor = Math.min(session.outputCursor, session.outputBuffer.length);
        });

        proc.stderr?.on('data', (chunk: Buffer | string) => {
            session.errorBuffer = this.trimBuffer(session.errorBuffer + chunk.toString());
            session.errorCursor = Math.min(session.errorCursor, session.errorBuffer.length);
        });

        proc.on('exit', (code, signal) => {
            session.closed = true;
            session.exitCode = code;
            session.signal = signal;
            session.status = 'idle';
            session.commandStartedAt = null;
        });

        this.sessions.set(id, session);
        this.lastSessionId = id;
        return id;
    }

    /**
     * Terminates and removes a terminal session.
     */
    async killTerminal(sessionId: string): Promise<string> {
        const session = this.getSession(sessionId);

        if (!session.closed) {
            session.process.kill();
        }

        this.sessions.delete(sessionId);
        if (this.lastSessionId === sessionId) {
            this.lastSessionId = undefined;
        }
        return `Terminal session ${sessionId} killed successfully.`;
    }

    /**
     * Lists active session identifiers.
     */
    listTerminalSessionIds(): string[] {
        return Array.from(this.sessions.keys());
    }

    /**
     * Returns a markdown table describing active terminal sessions.
     */
    listTerminals(): string {
        const sessions = Array.from(this.sessions.values());
        if (sessions.length === 0) {
            return 'No active terminal sessions.';
        }

        const rows = sessions.map((session) => {
            const safeCommand = (session.lastCommand ?? '(none)').replace(/\|/g, '\\|');
            const status = session.status === 'running'
                ? `active, has been running for ${Math.max(0, Math.floor((Date.now() - (session.commandStartedAt ?? Date.now())) / 1000))} seconds`
                : 'idle';
            return `| ${session.id} | ${status} | ${safeCommand} |`;
        });

        return [
            '| Session ID | Status | Last Command |',
            '| --- | --- | --- |',
            ...rows,
        ].join('\n');
    }

    /**
     * Sends a command to an existing session or implicitly creates one.
     */
    async sendCommandToTerminal(command: string, sessionId: string | undefined = undefined): Promise<string> {
        const session = await this.getOrCreateSession(sessionId);
        if (session.closed) {
            throw new Error(`Terminal session is already closed: ${session.id}`);
        }

        if (!session.process.stdin || session.process.stdin.destroyed) {
            throw new Error(`Terminal stdin is not writable for session: ${session.id}`);
        }

        this.markSessionUsed(session);
        session.lastCommand = command;
        session.status = 'running';
        session.commandStartedAt = Date.now();

        return new Promise((resolve, reject) => {
            session.process.stdin!.write(`${command}${process.platform === 'win32' ? '\r\n' : '\n'}`, (err) => {
                if (err) {
                    session.status = 'idle';
                    session.commandStartedAt = null;
                    reject(new Error(`Failed to send command to terminal ${session.id}: ${err.message}`));
                    return;
                }
                resolve(`Command sent to terminal ${session.id}.`);
            });
        });
    }

    /**
     * Convenience helper: send command then wait for the next output window.
     */
    async runCommandSimple(command: string, timeout: number = 5000, sessionId: string | undefined = undefined): Promise<{ session_id: string; output: string; timeout_ms: number; }> {
        const session = await this.getOrCreateSession(sessionId);

        // Keep this helper atomic for agents: write command, then wait for the next output chunk.
        await this.sendCommandToTerminal(command, session.id);
        const output = await this.waitForTerminalOutput(session.id, timeout);

        return {
            session_id: session.id,
            output,
            timeout_ms: timeout,
        };
    }

    /**
     * Waits for fresh terminal output (stdout/stderr deltas) within a timeout.
     */
    waitForTerminalOutput(sessionId: string | undefined = undefined, timeout: number = 5000): Promise<string> {
        const effectiveSessionId = sessionId ?? this.lastSessionId;
        if (!effectiveSessionId) {
            throw new Error('No terminal session available. Create one first or provide a session id.');
        }
        const session = this.getSession(effectiveSessionId);
        this.markSessionUsed(session);
        const deadline = Date.now() + Math.max(0, timeout);

        return new Promise((resolve) => {
            const flushOutput = (): string => {
                const stdoutDelta = session.outputBuffer.slice(session.outputCursor);
                const stderrDelta = session.errorBuffer.slice(session.errorCursor);
                session.outputCursor = session.outputBuffer.length;
                session.errorCursor = session.errorBuffer.length;

                if (stdoutDelta && stderrDelta) {
                    return `${stdoutDelta}\n${stderrDelta}`;
                }
                return stdoutDelta || stderrDelta;
            };

            const immediate = flushOutput();
            if (immediate) {
                resolve(immediate);
                return;
            }

            const timer = setInterval(() => {
                const chunk = flushOutput();
                if (chunk) {
                    clearInterval(timer);
                    // We treat "received output" as step completion for this helper contract.
                    // Long-running commands can still emit additional output in subsequent waits.
                    session.status = 'idle';
                    session.commandStartedAt = null;
                    resolve(chunk);
                    return;
                }

                if (session.closed || Date.now() >= deadline) {
                    clearInterval(timer);
                    session.status = 'idle';
                    session.commandStartedAt = null;
                    resolve(chunk || '');
                }
            }, 50);
        });
    }

    /***
     * If there are running terminal sessions, generate a message to the agent suggesting to check their status or kill them explicitly to free up resources.
     * This can help prevent issues in long-running agents that forget to manage their terminal sessions.
     */
    getWarningMessage() : string | null {
        const activeSessions = Array.from(this.sessions.values()).filter(s => !s.closed);
        if (activeSessions.length === 0) {
            return null;
        }
        return `Warning: There are currently ${activeSessions.length} active terminal session(s). ` +
            `Use the ListTerminals tool to check their status or the KillTerminal tool to free up resources if they are no longer needed.`;
    }

    /**
     * Reads buffered output without waiting. Defaults to the most recently used session.
     */
    readTerminalOutput(sessionId: string | undefined = undefined, numLines: number = 40): string {
        const effectiveSessionId = sessionId ?? this.lastSessionId;
        if (!effectiveSessionId) {
            throw new Error('No terminal session available. Create one first or provide a session id.');
        }
        const session = this.getSession(effectiveSessionId);
        const outputLines = session.outputBuffer.split(/\r?\n/);
        return outputLines.slice(-numLines).join('\n');
    }

    /**
     * Exposes terminal capabilities as AI SDK tools.
     */
    getToolSet(): ToolSet {
        const interpreterInfo = TerminalTools.detectInterpreter();
        const platformName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
        
        return {
            "CreateTerminal": {
                description: "Create a new terminal session and return its session id.",
                inputSchema: z.object({}),
                execute: async () => this.createTerminal(),
            } as Tool,
            "ListTerminals": {
                description: "List all active terminal sessions as a markdown table, including session id, last command, and status (idle or active with running duration in seconds).",
                inputSchema: z.object({}),
                execute: async () => this.listTerminals(),
            } as Tool,
            "SendCommandToTerminal": {
                description: "Send a shell command to a terminal session. If session_id is omitted, the most recent session is used or created automatically.",
                inputSchema: z.object({
                    command: z.string(),
                    session_id: z.string().optional(),
                }),
                execute: async ({ session_id, command }) => this.sendCommandToTerminal(command, session_id),
            } as Tool,
            "WaitForTerminalOutput": {
                description: "Wait for new output from a terminal session and return stdout/stderr chunks. If session_id is omitted, the most recent session is used.",
                inputSchema: z.object({
                    session_id: z.string().optional(),
                    timeout: z.number().optional(),
                }),
                execute: async ({ session_id, timeout }) => this.waitForTerminalOutput(session_id, timeout),
            } as Tool,
            "RunCommandSimple": {
                description: `Run a command and wait for output in one call using ${interpreterInfo.shell} on ${platformName}. ${interpreterInfo.comment} If session_id is omitted, the most recent session is used or created automatically.`,
                inputSchema: z.object({
                    command: z.string(),
                    timeout: z.number().optional(),
                    session_id: z.string().optional(),
                }),
                execute: async ({ command, timeout, session_id }) => this.runCommandSimple(command, timeout, session_id),
            } as Tool,
            "ReadTerminalOutput": {
                description: "Read the current buffered output of a terminal session. If session_id is omitted, the most recent session is used.",
                inputSchema: z.object({
                    session_id: z.string().optional(),
                    num_lines: z.number().optional(),
                }),
                execute: async ({ session_id, num_lines }) => this.readTerminalOutput(session_id, num_lines),
            } as Tool,
            "KillTerminal": {
                description: "Kill a terminal session by id.",
                inputSchema: z.object({
                    session_id: z.string(),
                }),
                execute: async ({ session_id }) => this.killTerminal(session_id),
            } as Tool,
        } as ToolSet;
    }
}