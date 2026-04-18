import { describe, expect, it } from 'bun:test';
import { streamText, type ModelMessage } from 'ai';
import { createModel } from '../src/agent/providers';

const defaultTimeout = 120000;

type CapturedChunk = {
    type: string;
    id?: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
};

describe('reasoning stream probe', () => {
    it('captures raw stream chunk types for ollama/gemma4:26b', async () => {
        const model = await createModel('ollama/gemma4:26b', { think: true });
        const captured: CapturedChunk[] = [];

        const result = streamText({
            model,
            maxRetries: 1,
            messages: [
                {
                    role: 'user',
                    content: 'Compute 57 * 2. Keep the answer short.',
                } satisfies ModelMessage,
            ],
            onChunk: async ({ chunk }) => {
                const raw = chunk as Record<string, unknown>;
                const text = typeof raw.text === 'string'
                    ? raw.text
                    : typeof raw.argsTextDelta === 'string'
                        ? raw.argsTextDelta
                        : undefined;

                captured.push({
                    type: String(raw.type),
                    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
                    ...(text !== undefined ? { text } : {}),
                    ...(typeof raw.toolCallId === 'string' ? { toolCallId: raw.toolCallId } : {}),
                    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
                });
            },
        });

        const [text, reasoningText] = await Promise.all([
            result.text,
            result.reasoningText,
        ]);

        console.log('Captured chunk types:', captured.map((chunk) => chunk.type));
        console.log('Captured chunks:', JSON.stringify(captured, null, 2));
        console.log('Final text:', text);
        console.log('Final reasoningText:', reasoningText ?? '<none>');

        expect(text.length).toBeGreaterThan(0);
    }, defaultTimeout);
});