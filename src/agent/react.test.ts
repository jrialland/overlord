import { describe, expect, it } from 'bun:test';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { Bus } from '../bus';
import { makeReActGraph, type ReActEvent } from './react';
import { HasMessages } from './types';
import { z } from 'zod';

function createEventCollector() {
    const bus = new Bus();
    const topic = bus.getTopic<ReActEvent>('react-test-events');
    const events: ReActEvent[] = [];

    topic.subscribe(async (event) => {
        events.push(event);
    });

    return { topic, events };
}

describe('makeReActGraph', () => {
    it('appends full response messages without losing tool calls and tool results', async () => {
        const initialMessages: ModelMessage[] = [
            { role: 'user', content: 'What is the weather in Paris?' },
        ];
        const state = new HasMessages(initialMessages);

        const assistantMessage = {
            role: 'assistant',
            content: [
                {
                    type: 'tool-call',
                    toolCallId: 'call_1',
                    toolName: 'weather',
                    input: { city: 'Paris' },
                },
            ],
        } as ModelMessage;

        const toolMessage = {
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'call_1',
                    toolName: 'weather',
                    output: { type: 'json', value: { tempC: 18, condition: 'sunny' } },
                },
            ],
        } as ModelMessage;

        const finalAssistantMessage = {
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: 'It is sunny and 18C in Paris.',
                },
            ],
        } as ModelMessage;

        const stubStreamText: typeof import('ai').streamText = (_options: any) => {
            async function* fullStream() {
                yield { type: 'text-delta', id: 'chunk-1', text: 'It ' };
                yield { type: 'text-delta', id: 'chunk-1', text: 'is sunny.' };
            }
            return {
                fullStream: fullStream(),
                finishReason: Promise.resolve('stop'),
                usage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
                totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
                steps: Promise.resolve([]),
                response: Promise.resolve({
                    id: 'res_1',
                    modelId: 'unit-test-model',
                    timestamp: new Date(),
                    messages: [assistantMessage, toolMessage, finalAssistantMessage],
                }),
            } as any;
        };

        const modelStub = {} as LanguageModel;
        const { topic } = createEventCollector();
        const graph = makeReActGraph({
            model: modelStub,
            maxRetries: 3,
            toolsProvider: async () => ({}) as ToolSet,
            eventTopic: topic,
            streamTextFn: stubStreamText,
        });

        const result = await graph.execute(state);

        expect(result.messages.length).toBe(4);
        expect(result.messages[1]).toEqual(assistantMessage);
        expect(result.messages[2]).toEqual(toolMessage);
        expect(result.messages[3]).toEqual(finalAssistantMessage);
    });

    it('emits model_response event with response messages', async () => {
        const state = new HasMessages([{ role: 'user', content: 'Hi' }]);
        const { topic, events } = createEventCollector();

        const stubStreamText: typeof import('ai').streamText = (_options: any) => {
            async function* fullStream() {
                yield { type: 'thinking-delta', id: 'reason-1', text: 'thinking...' };
                yield { type: 'text-delta', id: 'chunk-2', text: 'he' };
                yield { type: 'text-delta', id: 'chunk-2b', text: 'llo' };
            }

            return {
                fullStream: fullStream(),
                finishReason: Promise.resolve('stop'),
                usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                steps: Promise.resolve([{ stepNumber: 0 }] as any),
                response: Promise.resolve({
                    id: 'res_2',
                    modelId: 'unit-test-model',
                    timestamp: new Date(),
                    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
                }),
            } as any;
        };

        const graph = makeReActGraph({
            model: {} as LanguageModel,
            maxRetries: 3,
            toolsProvider: async () => ({}),
            eventTopic: topic,
            streamTextFn: stubStreamText,
        });

        await graph.execute(state);

        const modelResponseEvent = events.find((event: any) => event.type === 'model_response') as any;
        expect(modelResponseEvent).toBeTruthy();
        expect(Array.isArray(modelResponseEvent.responseMessages)).toBe(true);
        expect(modelResponseEvent.responseMessages.length).toBe(1);

        const responseChunkEvents = events.filter((event: any) => event.type === 'response_chunk');
        expect(responseChunkEvents.length).toBe(2);
        expect((responseChunkEvents[0] as any).text).toBe('he');
        expect((responseChunkEvents[1] as any).text).toBe('llo');

        const reasoningChunkEvents = events.filter((event: any) => event.type === 'reasoning_chunk');
        expect(reasoningChunkEvents.length).toBe(1);
        expect((reasoningChunkEvents[0] as any).text).toBe('thinking...');

        const reasoningStartEvents = events.filter((event: any) => event.type === 'reasoning_start');
        expect(reasoningStartEvents.length).toBe(1);

        const reasoningDeltaEvents = events.filter((event: any) => event.type === 'reasoning_delta');
        expect(reasoningDeltaEvents.length).toBe(0);
        const reasoningEndEvents = events.filter((event: any) => event.type === 'reasoning_end');
        expect(reasoningEndEvents.length).toBe(1);

        const responseStartEvents = events.filter((event: any) => event.type === 'response_start');
        expect(responseStartEvents.length).toBe(1);
        const responseEndEvents = events.filter((event: any) => event.type === 'response_end');
        expect(responseEndEvents.length).toBe(1);

        const deprecatedStreamChunkEvents = events.filter((event: any) => event.type === 'stream_chunk');
        expect(deprecatedStreamChunkEvents.length).toBe(0);
    });

    it('does not synthesize reasoning from <think> tags in text-delta chunks', async () => {
        const state = new HasMessages([{ role: 'user', content: 'Hi' }]);
        const { topic, events } = createEventCollector();

        const stubStreamText: typeof import('ai').streamText = (_options: any) => {
            async function* fullStream() {
                yield { type: 'text-delta', id: 'chunk-3', text: '<think>step ' };
                yield { type: 'text-delta', id: 'chunk-3b', text: 'by step</think>hello' };
            }
            return {
                fullStream: fullStream(),
                finishReason: Promise.resolve('stop'),
                usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                steps: Promise.resolve([{ stepNumber: 0 }] as any),
                response: Promise.resolve({
                    id: 'res_3',
                    modelId: 'unit-test-model',
                    timestamp: new Date(),
                    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
                }),
            } as any;
        };

        const graph = makeReActGraph({
            model: {} as LanguageModel,
            maxRetries: 3,
            toolsProvider: async () => ({}),
            eventTopic: topic,
            streamTextFn: stubStreamText,
        });

        await graph.execute(state);

        const reasoningChunkEvents = events.filter((event: any) => event.type === 'reasoning_chunk');
        expect(reasoningChunkEvents.length).toBe(0);

        const responseChunkEvents = events.filter((event: any) => event.type === 'response_chunk');
        expect(responseChunkEvents.length).toBe(2);
        expect((responseChunkEvents[0] as any).text).toContain('<think>step ');
        expect((responseChunkEvents[1] as any).text).toContain('by step</think>hello');
    });

    it('handles optional structured output with schema and callback', async () => {
        const state = new HasMessages([{ role: 'user', content: 'Return structured output' }]);
        const { topic, events } = createEventCollector();
        const schema = z.object({
            answer: z.string(),
            confidence: z.number(),
        });

        let callbackPayload: unknown;
        let callbackState: HasMessages | undefined;
        let receivedOutputOption: unknown;

        const stubStreamText: typeof import('ai').streamText = (options: any) => {
            receivedOutputOption = options.output;
            return {
                finishReason: Promise.resolve('stop'),
                usage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
                totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
                steps: Promise.resolve([{ stepNumber: 0 }] as any),
                output: Promise.resolve({ answer: 'done', confidence: 0.98 }),
                response: Promise.resolve({
                    id: 'res_structured',
                    modelId: 'unit-test-model',
                    timestamp: new Date(),
                    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
                }),
            } as any;
        };

        const graph = makeReActGraph({
            model: {} as LanguageModel,
            maxRetries: 3,
            toolsProvider: async () => ({}),
            eventTopic: topic,
            streamTextFn: stubStreamText,
            structuredOutput: {
                schema,
                name: 'final_response',
                description: 'Final response in JSON format',
                onOutput: async (output, currentState) => {
                    callbackPayload = output;
                    callbackState = currentState;
                },
            },
        });

        await graph.execute(state);

        expect(receivedOutputOption).toBeTruthy();
        expect((receivedOutputOption as any).name).toBe('object');

        expect(callbackPayload).toEqual({ answer: 'done', confidence: 0.98 });
        expect(callbackState).toBe(state);

        const structuredOutputEvent = events.find((event: any) => event.type === 'structured_output') as any;
        expect(structuredOutputEvent).toBeTruthy();
        expect(structuredOutputEvent.output).toEqual({ answer: 'done', confidence: 0.98 });
    });

    it('normalizes tool call events to a strict schema', async () => {
        const state = new HasMessages([{ role: 'user', content: 'Use a tool' }]);
        const { topic, events } = createEventCollector();

        const stubStreamText: typeof import('ai').streamText = (_options: any) => {
            void _options.experimental_onToolCallStart?.({
                callId: 'call_99',
                stepNumber: 0,
                provider: 'test-provider',
                modelId: 'test-model',
                toolCall: {
                    toolCallId: 'call_99',
                    toolName: 'list_files',
                    input: { path: '.' },
                },
                messages: [],
                abortSignal: undefined,
                functionId: undefined,
                metadata: undefined,
                context: undefined,
            });
            void _options.experimental_onToolCallFinish?.({
                callId: 'call_99',
                stepNumber: 0,
                provider: 'test-provider',
                modelId: 'test-model',
                toolCall: {
                    toolCallId: 'call_99',
                    toolName: 'list_files',
                    input: { path: '.' },
                },
                messages: [],
                abortSignal: undefined,
                durationMs: 1,
                functionId: undefined,
                metadata: undefined,
                context: undefined,
                success: true,
                output: ['a.txt'],
            });

            return {
                finishReason: Promise.resolve('stop'),
                usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                steps: Promise.resolve([]),
                response: Promise.resolve({
                    id: 'res_tool_norm',
                    modelId: 'unit-test-model',
                    timestamp: new Date(),
                    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
                }),
            } as any;
        };

        const graph = makeReActGraph({
            model: {} as LanguageModel,
            maxRetries: 3,
            toolsProvider: async () => ({}),
            eventTopic: topic,
            streamTextFn: stubStreamText,
        });

        await graph.execute(state);

        const startEvent = events.find((event: any) => event.type === 'tool_call_start') as any;
        const finishEvent = events.find((event: any) => event.type === 'tool_call_finish') as any;

        expect(startEvent).toMatchObject({
            type: 'tool_call_start',
            toolCallId: 'call_99',
            toolName: 'list_files',
            input: { path: '.' },
        });

        expect(finishEvent).toMatchObject({
            type: 'tool_call_finish',
            toolCallId: 'call_99',
            toolName: 'list_files',
            output: ['a.txt'],
        });

        expect(startEvent.toolCall).toBeUndefined();
        expect(finishEvent.toolCall).toBeUndefined();
    });

    it('normalizes AI SDK tool call callback shape', async () => {
        const state = new HasMessages([{ role: 'user', content: 'Use a wrapped callback tool event' }]);
        const { topic, events } = createEventCollector();

        const stubStreamText: typeof import('ai').streamText = (_options: any) => {
            void _options.experimental_onToolCallStart?.({
                callId: 'call_wrapped_1',
                stepNumber: 0,
                provider: 'test-provider',
                modelId: 'test-model',
                toolCall: {
                    toolCallId: 'call_wrapped_1',
                    toolName: 'read_file',
                    input: { path: 'README.md' },
                },
                messages: [],
                abortSignal: undefined,
                functionId: undefined,
                metadata: undefined,
                context: undefined,
            });

            return {
                finishReason: Promise.resolve('stop'),
                usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
                steps: Promise.resolve([]),
                response: Promise.resolve({
                    id: 'res_tool_wrapped',
                    modelId: 'unit-test-model',
                    timestamp: new Date(),
                    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
                }),
            } as any;
        };

        const graph = makeReActGraph({
            model: {} as LanguageModel,
            maxRetries: 3,
            toolsProvider: async () => ({}),
            eventTopic: topic,
            streamTextFn: stubStreamText,
        });

        await graph.execute(state);

        const startEvent = events.find((event: any) => event.type === 'tool_call_start') as any;
        expect(startEvent).toMatchObject({
            type: 'tool_call_start',
            toolCallId: 'call_wrapped_1',
            toolName: 'read_file',
            input: { path: 'README.md' },
        });
    });
});

describe('HasMessages serialization', () => {
    it('round-trips through JSON without losing content', () => {
        const original = new HasMessages([
            { role: 'system', content: 'You are helpful.' },
            {
                role: 'assistant',
                content: [
                    { type: 'tool-call', toolCallId: 'call_42', toolName: 'math', input: { value: 2 } },
                ],
            } as ModelMessage,
            {
                role: 'tool',
                content: [
                    { type: 'tool-result', toolCallId: 'call_42', toolName: 'math', output: { type: 'json', value: { value: 4 } } },
                ],
            } as ModelMessage,
        ]);

        const serialized = original.toJSON();
        const restored = HasMessages.fromJSON(serialized);

        expect(restored.messages).toEqual(original.messages);
    });
});

