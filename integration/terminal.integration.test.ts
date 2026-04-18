import { describe, expect, it } from 'bun:test';
import type { ModelMessage, ToolCallPart, ToolResultPart, UserModelMessage } from 'ai';
import { makeReActGraph } from '../src/agent/react';
import { createModel } from '../src/agent/providers';
import { HasMessages } from '../src/agent/types';
import { TerminalTools } from '../src/tools/terminal';

const defaultTimeout = 120000;

function collectToolCallNames(messages: ModelMessage[]): string[] {
    const names: string[] = [];
    for (const message of messages) {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) {
            continue;
        }
        for (const part of message.content) {
            if (part.type === 'tool-call') {
                names.push((part as ToolCallPart).toolName);
            }
        }
    }
    return names;
}

function collectToolResults(messages: ModelMessage[]): ToolResultPart[] {
    const results: ToolResultPart[] = [];
    for (const message of messages) {
        if (message.role !== 'tool' || !Array.isArray(message.content)) {
            continue;
        }
        for (const part of message.content) {
            if (part.type === 'tool-result') {
                results.push(part as ToolResultPart);
            }
        }
    }
    return results;
}

function extractAssistantText(messages: ModelMessage[]): string {
    const assistantMessage = messages.findLast((m) => m.role === 'assistant');
    if (!assistantMessage) {
        return '';
    }
    const content = assistantMessage.content;
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
        .trim();
}

describe('Terminal tools integration with ReAct', () => {
    it('lets the model execute multiple shell commands through terminal tools', async () => {
        const terminalTools = new TerminalTools(process.cwd(), { watchdogIntervalMs: 60_000 });
        const model = await createModel('ollama/glm-5:cloud', { think: true });

        try {
            const graph = makeReActGraph({
                model,
                name: 'terminal-integration',
                maxRetries: 3,
                toolsProvider: async () => terminalTools.getToolSet(),
            });

            const osCommand = process.platform === 'win32' ? '$PSVersionTable.PSEdition' : 'uname -s';

            const initialMessages = [
                {
                    role: 'system',
                    content: 'You must call tools to answer. You are not allowed to answer from prior knowledge.',
                } as ModelMessage,
                {
                    role: 'user',
                    content: `Use run_command_simple twice. First run: echo TERMINAL_INTEGRATION_OK. Second run: ${osCommand}. Then summarize both outputs in one short answer.`,
                } as UserModelMessage,
            ];

            const finalState = await graph.execute(new HasMessages(initialMessages));
            const toolCallNames = collectToolCallNames(finalState.messages);
            const toolResults = collectToolResults(finalState.messages);
            const finalText = extractAssistantText(finalState.messages);

            expect(toolCallNames).toContain('RunCommandSimple');
            expect(toolResults.length).toBeGreaterThan(0);

            const flattenedToolResultJson = JSON.stringify(toolResults);
            expect(flattenedToolResultJson).toContain('TERMINAL_INTEGRATION_OK');

            expect(finalText.length).toBeGreaterThan(0);
        } finally {
            for (const id of terminalTools.listTerminalSessionIds()) {
                await terminalTools.killTerminal(id);
            }
        }
    }, defaultTimeout);

    it('can answer a question about ipconfig output on Windows using terminal tools', async () => {
        if (process.platform !== 'win32') {
            return;
        }

        const terminalTools = new TerminalTools(process.cwd(), { watchdogIntervalMs: 60_000 });
        const model = await createModel('ollama/glm-5:cloud', { think: true });

        try {
            const graph = makeReActGraph({
                model,
                name: 'terminal-ipconfig-integration',
                maxRetries: 3,
                toolsProvider: async () => terminalTools.getToolSet(),
            });

            const initialMessages = [
                {
                    role: 'system',
                    content: 'You must use terminal tools. Run commands before answering.',
                } as ModelMessage,
                {
                    role: 'user',
                    content: 'Run ipconfig with run_command_simple, then answer: does the output contain an IPv4 Address entry? Quote one matching line if present.',
                } as UserModelMessage,
            ];

            const finalState = await graph.execute(new HasMessages(initialMessages));
            const toolCallNames = collectToolCallNames(finalState.messages);
            const toolResults = collectToolResults(finalState.messages);
            const finalText = extractAssistantText(finalState.messages);

            expect(toolCallNames).toContain('RunCommandSimple');
            expect(toolResults.length).toBeGreaterThan(0);

            const flattenedToolResultJson = JSON.stringify(toolResults).toLowerCase();
            expect(flattenedToolResultJson).toContain('ipv4');

            expect(finalText.toLowerCase()).toContain('ipv4');
        } finally {
            for (const id of terminalTools.listTerminalSessionIds()) {
                await terminalTools.killTerminal(id);
            }
        }
    }, defaultTimeout);
});
