import { z } from "zod";
import { HasMessages } from "./types";
import { Graph } from "./graph";
import { type LanguageModel, streamText, isLoopFinished, type ToolSet, type ModelMessage, Output } from "ai";
import { logger } from "../logging";
import { NullTopic, type Topic } from "../bus";

export type ReasoningChunkEvent = {
    type: 'reasoning_chunk';
    id: string;
    text: string;
};

export type ResponseChunkEvent = {
    type: 'response_chunk';
    id: string;
    text: string;
};

export type ToolCallStartEvent = {
    type: 'tool_call_start';
    toolCallId: string;
    toolName: string;
    input?: unknown;
};

export type ToolCallFinishEvent = {
    type: 'tool_call_finish';
    toolCallId: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
};

export type StepFinishEvent = {
    type: 'step_finish';
    step: unknown;
};

export type StructuredOutputEvent = {
    type: 'structured_output';
    output: unknown;
};

export type ModelResponseEvent = {
    type: 'model_response';
    finishReason: unknown;
    usage: unknown;
    totalUsage: unknown;
    responseMessages: unknown;
    steps: unknown;
    /** Exact input token count from the last step = real context window occupancy. Undefined when the provider did not report usage. */
    contextFillTokens?: number;
};

export type ReasoningStartEvent = {
    type: 'reasoning_start';
};

export type ReasoningEndEvent = {
    type: 'reasoning_end';
};

export type ResponseStartEvent = {
    type: 'response_start';
};

export type ResponseEndEvent = {
    type: 'response_end';
};

export type ReActEvent =
    | ReasoningChunkEvent
    | ResponseChunkEvent
    | ToolCallStartEvent
    | ToolCallFinishEvent
    | StepFinishEvent
    | StructuredOutputEvent
    | ModelResponseEvent
    | ReasoningStartEvent
    | ReasoningEndEvent
    | ResponseStartEvent
    | ResponseEndEvent;

type NormalizedToolCallEvent = {
    toolCallId: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
};

type StreamTextCallOptions = Parameters<typeof streamText>[0];
type OnToolCallStartEventArg = Parameters<NonNullable<StreamTextCallOptions['experimental_onToolCallStart']>>[0];
type OnToolCallFinishEventArg = Parameters<NonNullable<StreamTextCallOptions['experimental_onToolCallFinish']>>[0];

/**
 * Normalizes AI SDK tool-callback events into a single internal shape used by ReActEvent.
 *
 * The start callback and finish callback share the same `toolCall` envelope but differ
 * on output semantics. Start events do not carry execution output; finish events only do
 * when `success === true`.
 */
function normalizeToolCallEvent(toolCall: OnToolCallStartEventArg | OnToolCallFinishEventArg): NormalizedToolCallEvent {
    if (!toolCall || typeof toolCall !== 'object') {
        throw new Error('Invalid tool call event: expected an object');
    }

    const event = toolCall as OnToolCallStartEventArg | OnToolCallFinishEventArg;
    const raw = event.toolCall;

    const toolCallId = raw.toolCallId;
    const toolName = raw.toolName;

    if (!toolCallId) {
        throw new Error(`Tool call event missing toolCallId: ${JSON.stringify(toolCall)}`);
    }
    if (!toolName) {
        throw new Error(`Tool call event missing toolName: ${JSON.stringify(toolCall)}`);
    }

    const input = raw.input;
    const output = 'success' in event && event.success ? event.output : undefined;

    return {
        toolCallId,
        toolName,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
    };
}

export type StructuredOutputOptions<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
    schema: TSchema;
    name?: string;
    description?: string;
    onOutput?: (output: z.infer<TSchema>, state: HasMessages) => Promise<void>;
};

export type MakeReActGraphOptions = {
    model: LanguageModel;
    name?: string;
    maxRetries?: number;
    reasoning?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    toolsProvider?: (state: HasMessages) => Promise<ToolSet>;
    eventTopic?: Topic<ReActEvent>;
    streamTextFn?: typeof streamText;
    structuredOutput?: StructuredOutputOptions;
    /** Enable advanced reasoning/thinking to capture and display model thought process */
    enableReasoning?: boolean;
};

/**
 * Builds the core ReAct execution graph.
 *
 * The graph currently has a single model invocation node but still uses the graph abstraction
 * to keep extension points (tool loops, branching, retries, subgraphs) explicit.
 */
export function makeReActGraph(options: MakeReActGraphOptions): Graph<HasMessages> {
    const {
        model,
        name = "ReAct",
        maxRetries = 3,
        reasoning,
        toolsProvider = async () => ({}),
        eventTopic = NullTopic as Topic<ReActEvent>,
        streamTextFn = streamText,
        structuredOutput,
        enableReasoning = true,
    } = options;

    const g = new Graph<HasMessages>(name);

    /**
     * Executes one model step: stream UI events, collect final response messages,
     * and append those messages back into the shared conversation state.
     */
    async function invokeModelAction(state: HasMessages): Promise<HasMessages> {
        const tools = await toolsProvider(state);
        const messages = state.messages;
        let fallbackReasoningId = 0;
        let fallbackResponseId = 0;

        // Track the current streaming mode to emit start/end boundary events.
        // responseStarted is a one-way latch: once the model begins its response, any
        // subsequent reasoning/thinking chunks from the model are late-stage completions
        // of prior thoughts and are dropped to prevent interleaved reasoning/response blocks.
        type StreamMode = 'idle' | 'reasoning' | 'response';
        let streamMode: StreamMode = 'idle';
        let responseStarted = false;
        // Tracks the inputTokens from the most recent finish-step chunk.
        // The last value after the stream ends = actual context window fill for this turn.
        let lastStepInputTokens: number | undefined = undefined;

        const setStreamMode = async (newMode: StreamMode): Promise<void> => {
            if (streamMode === newMode) return;
            if (streamMode === 'reasoning') await eventTopic.publish({ type: 'reasoning_end' });
            if (streamMode === 'response') await eventTopic.publish({ type: 'response_end' });
            streamMode = newMode;
            if (newMode === 'reasoning') await eventTopic.publish({ type: 'reasoning_start' });
            if (newMode === 'response') await eventTopic.publish({ type: 'response_start' });
        };

        const outputSpec = structuredOutput
            ? Output.object({
                schema: structuredOutput.schema,
                ...(structuredOutput.name ? { name: structuredOutput.name } : {}),
                ...(structuredOutput.description ? { description: structuredOutput.description } : {}),
            })
            : undefined;

        // Build streamText call with appropriate reasoning/think options.
        // All text and reasoning events are handled exclusively via fullStream to guarantee
        // that start/end boundary events are emitted before the first chunk of each mode.
        const streamTextCallBase = {
            model: model,
            maxRetries: maxRetries,
            messages: messages,
            tools,
            stopWhen: isLoopFinished(),
            output: outputSpec,
            experimental_onToolCallStart: async (toolCall: OnToolCallStartEventArg) => {
                const normalized = normalizeToolCallEvent(toolCall);
                await eventTopic.publish({
                    type: 'tool_call_start',
                    toolCallId: normalized.toolCallId,
                    toolName: normalized.toolName,
                    ...(normalized.input !== undefined ? { input: normalized.input } : {}),
                });
            },
            experimental_onToolCallFinish: async (toolCall: OnToolCallFinishEventArg) => {
                const normalized = normalizeToolCallEvent(toolCall);
                await eventTopic.publish({
                    type: 'tool_call_finish',
                    toolCallId: normalized.toolCallId,
                    toolName: normalized.toolName,
                    ...(normalized.input !== undefined ? { input: normalized.input } : {}),
                    ...(normalized.output !== undefined ? { output: normalized.output } : {}),
                });
            },
            onStepFinish: async (step: unknown) => {
                await eventTopic.publish({ type: 'step_finish', step });
            },
        };

        // Merge reasoning/thinking options: provider implementations vary.
        // - Ollama: uses providerOptions.ollama.think
        // - OpenAI, Anthropic, etc: use the reasoning parameter
        const streamTextCall = {
            ...streamTextCallBase,
            ...(enableReasoning
                ? { reasoning: reasoning || 'high', providerOptions: { ollama: { think: true } } }
                : reasoning
                ? { reasoning }
                : {}),
        };

        const result = streamTextFn(streamTextCall);

        // Consume fullStream to capture reasoning/thinking chunks
        try {
            for await (const chunk of result.fullStream) {
                // Cast to the narrowest shape we actually access; other chunk types are ignored.
                const c = chunk as { type?: string; text?: string; id?: string; usage?: { inputTokens?: number } };
                const chunkType = c.type;

                if (chunkType === 'reasoning-delta' || chunkType === 'reasoning' ||
                    chunkType === 'thinking-delta' || chunkType === 'thinking') {
                    // Ignore reasoning chunks that arrive after the response has started —
                    // they are late-stage model thoughts interleaved with output tokens.
                    if (responseStarted) continue;
                    await setStreamMode('reasoning');
                    const id = c.id ?? `reasoning-${++fallbackReasoningId}`;
                    await eventTopic.publish({ type: 'reasoning_chunk', id, text: c.text ?? '' });
                } else if (chunkType === 'text-delta' || chunkType === 'text') {
                    responseStarted = true;
                    await setStreamMode('response');
                    const id = c.id ?? `response-${++fallbackResponseId}`;
                    if (c.text) await eventTopic.publish({ type: 'response_chunk', id, text: c.text });
                } else if (
                    chunkType === 'tool-call' ||
                    chunkType === 'tool-call-delta' ||
                    chunkType === 'tool-call-streaming-start' ||
                    chunkType === 'finish' ||
                    chunkType === 'finish-step' ||
                    chunkType === 'step-finish' ||
                    chunkType === 'error'
                ) {
                    // Capture per-step input tokens from finish-step chunks.
                    // The last captured value equals the real context fill for this turn.
                    if ((chunkType === 'finish-step' || chunkType === 'step-finish') && c.usage?.inputTokens) {
                        lastStepInputTokens = c.usage.inputTokens;
                    }
                    // These chunk types signal the model has stopped generating text/reasoning.
                    await setStreamMode('idle');
                }
                // All other chunk types (step-start, stream-start, etc.) do not affect mode.
            }
        } catch (error) {
            logger.error({ error }, 'Failed to consume fullStream');
        }

        // Close any open reasoning/response mode after the stream ends.
        await setStreamMode('idle');

        const [response, finishReason, usage, totalUsage, steps] = await Promise.all([
            result.response,
            result.finishReason,
            result.usage,
            result.totalUsage,
            result.steps,
        ]);

        if (structuredOutput) {
            const structuredData = await result.output;
            await eventTopic.publish({ type: 'structured_output', output: structuredData });
            await structuredOutput.onOutput?.(structuredData, state);
        }

        // Preserve full-fidelity messages, including assistant tool-calls and tool results.
        state.appendMessages(response.messages as ModelMessage[]);

        await eventTopic.publish({
            type: 'model_response',
            finishReason,
            usage,
            totalUsage,
            responseMessages: response.messages,
            steps,
            ...(lastStepInputTokens !== undefined ? { contextFillTokens: lastStepInputTokens } : {}),
        });

        return state;
    }

    g.addNode("invoke_model", invokeModelAction);
    g.addEdge(g.START, "invoke_model");
    g.addEdge("invoke_model", g.END);

    return g;
}
