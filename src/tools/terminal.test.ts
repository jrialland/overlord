import { describe, expect, it } from 'bun:test';

import { TerminalTools } from './terminal';

describe('TerminalTools', () => {
    it('creates a terminal session, executes a command, and kills the session', async () => {
        const tools = new TerminalTools(process.cwd(), { watchdogIntervalMs: 60_000 });
        const sessionId = await tools.createTerminal();

        expect(sessionId.length).toBeGreaterThan(0);
        expect(tools.listTerminals()).toContain(sessionId);
        expect(tools.listTerminals()).toContain('| Session ID | Status | Last Command |');

        await tools.sendCommandToTerminal('echo terminal-tools-ok', sessionId);

        let output = '';
        const deadline = Date.now() + 4000;
        while (!output.includes('terminal-tools-ok') && Date.now() < deadline) {
            output += await tools.waitForTerminalOutput(sessionId, 300);
        }

        expect(output).toContain('terminal-tools-ok');

        const killResult = await tools.killTerminal(sessionId);
        expect(killResult).toContain('killed successfully');
        expect(tools.listTerminals()).toContain('No active terminal sessions.');
    });

    it('auto-creates and tracks last session when sending command without session id', async () => {
        const tools = new TerminalTools(process.cwd(), { watchdogIntervalMs: 60_000 });

        const sendResult = await tools.sendCommandToTerminal('echo auto-session-ok');
        expect(sendResult).toContain('Command sent to terminal');
        expect(tools.listTerminalSessionIds().length).toBe(1);

        let output = '';
        const deadline = Date.now() + 4000;
        while (!output.includes('auto-session-ok') && Date.now() < deadline) {
            output += await tools.waitForTerminalOutput(undefined, 300);
        }

        expect(output).toContain('auto-session-ok');

        for (const id of tools.listTerminalSessionIds()) {
            await tools.killTerminal(id);
        }
    });

    it('enforces a maximum of 5 sessions by default', async () => {
        const tools = new TerminalTools(process.cwd(), { watchdogIntervalMs: 60_000 });
        const ids: string[] = [];

        for (let i = 0; i < 5; i++) {
            ids.push(await tools.createTerminal());
        }

        await expect(tools.createTerminal()).rejects.toThrow('Maximum number of terminal sessions reached (5)');

        for (const id of ids) {
            await tools.killTerminal(id);
        }
    });

    it('watchdog drops idle sessions automatically', async () => {
        const tools = new TerminalTools(process.cwd(), {
            idleTimeoutMs: 80,
            watchdogIntervalMs: 25,
        });

        const sessionId = await tools.createTerminal();
        expect(tools.listTerminals()).toContain(sessionId);

        await new Promise((resolve) => setTimeout(resolve, 220));
        expect(tools.listTerminals()).toContain('No active terminal sessions.');
    });

    it('runs command and waits for output in one call', async () => {
        const tools = new TerminalTools(process.cwd(), { watchdogIntervalMs: 60_000 });

        const result = await tools.runCommandSimple('echo run-command-simple-ok', 2000);

        expect(result.session_id.length).toBeGreaterThan(0);
        expect(result.timeout_ms).toBe(2000);
        expect(result.output).toContain('run-command-simple-ok');

        await tools.killTerminal(result.session_id);
    });

    it('shows active status with running duration in listTerminals', async () => {
        const tools = new TerminalTools(process.cwd(), { watchdogIntervalMs: 60_000 });
        const sessionId = await tools.createTerminal();

        const slowCommand = process.platform === 'win32'
            ? 'Start-Sleep -Seconds 1; echo terminal-status-ok'
            : 'sleep 1; echo terminal-status-ok';

        await tools.sendCommandToTerminal(slowCommand, sessionId);

        const listingWhileRunning = tools.listTerminals();
        expect(listingWhileRunning).toContain(sessionId);
        expect(listingWhileRunning).toContain('active, has been running for');
        expect(listingWhileRunning).toContain(slowCommand);

        const output = await tools.waitForTerminalOutput(sessionId, 4000);
        expect(output).toContain('terminal-status-ok');

        const listingAfterCompletion = tools.listTerminals();
        expect(listingAfterCompletion).toContain('idle');

        await tools.killTerminal(sessionId);
    });
});
