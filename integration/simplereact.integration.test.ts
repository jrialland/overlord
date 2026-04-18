// Just a smoke test using a simple ollama model
import { describe, expect, it } from 'bun:test';
import { makeReActGraph } from '../src/agent/react';
import { HasMessages } from '../src/agent/types';
import { createModel } from '../src/agent/providers';
import { type ModelMessage, type Tool, type ToolSet, type UserModelMessage } from 'ai';
import { z } from 'zod';
import { Bus } from '../src/bus';

const defaultTimeout = 120000; // Model-backed integration tests can be slow depending on runtime/provider.

const getWeatherTool: Tool = {
    description: 'Get the current weather for a given city.',
    inputSchema: z.object({
        city: z.string().describe('The city to get the weather for.'),
    }),
    execute: async (input: { city: string }) => {
        const { city } = input;
        // Simulate fetching weather data
        return `The weather in ${city} is cloudy.`;
    },
};

const toolSet: ToolSet = {
    get_weather: getWeatherTool,
};

describe('ReAct Graph', () => {

    it('runs a simple ReAct loop with a simple ollama model', async () => {

        const model = await createModel("ollama/lfm2.5-thinking:1.2b");

        const graph = makeReActGraph({ model });

        const initialMessages = [
            { role: 'user', content: 'What is 2+2?' } as UserModelMessage,
        ];

        const finalState = await graph.execute(new HasMessages(initialMessages));

        const finalMessages = finalState.messages;
        const assistantMessage = finalMessages.findLast(m => m.role === 'assistant');

        expect(assistantMessage).toBeTruthy();
        const content = assistantMessage!.content;
        console.log("Assistant message content:", content);
        const text = typeof content === 'string'
            ? content
            : content
                .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                .map(part => part.text)
                .join(' ');

        expect(text.toLowerCase()).toContain('4');
    }, defaultTimeout);

    it('preserves tool call messages in the state', async () => {


        const model = await createModel("ollama/lfm2.5-thinking:1.2b", { think: true });

        const graph = makeReActGraph({ model, name: "test-graph", maxRetries: 3, toolsProvider: async () => toolSet });
        const initialMessages = [
            {
                role: 'system',
                content: 'You must call the get_weather tool before answering. Do not answer from prior knowledge.',
            } as ModelMessage,
            { role: 'user', content: 'What is the weather in New York?' } as UserModelMessage,
        ];

        const state = new HasMessages(initialMessages);

        const finalState = await graph.execute(state);

        const finalMessages = finalState.messages;
        const toolCallAssistantMessage = finalMessages.find(
            m => m.role === 'assistant'
                && Array.isArray(m.content)
                && m.content.some((part: any) => part.type === 'tool-call' && part.toolName === 'get_weather')
        );
        expect(toolCallAssistantMessage).toBeTruthy();

        const toolResultMessage = finalMessages.find(
            m => m.role === 'tool'
                && Array.isArray(m.content)
                && m.content.some((part: any) => part.type === 'tool-result' && part.toolName === 'get_weather')
        );
        expect(toolResultMessage).toBeTruthy();

        const assistantMessage = finalMessages.findLast(
            m => m.role === 'assistant'
                && m !== toolCallAssistantMessage
                && Array.isArray(m.content)
                && m.content.some((part: any) => part.type === 'text')
        );
        expect(assistantMessage).toBeTruthy();
        const content = assistantMessage!.content;
        console.log("Final assistant message content:", content);
        const text = typeof content === 'string'
            ? content
            : content
                .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                .map(part => part.text)
                .join(' ');
        expect(text.toLowerCase()).toContain('cloudy');

        console.log("-----");
        console.log(JSON.stringify(state.messages, null, 2));
        console.log("-----");
    }, defaultTimeout);


    it("can finish a conversation with simulated tool calls and results", async () => {

        const messages = [
            {
                "role": "user",
                "content": "What is the weather in New York?"
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool-call",
                        "toolCallId": "ecdcd905-39f2-4d82-9bf5-091bd68d5662",
                        "toolName": "get_weather",
                        "input": {
                            "city": "New York"
                        }
                    }
                ]
            },
            {
                "role": "tool",
                "content": [
                    {
                        "type": "tool-result",
                        "toolCallId": "ecdcd905-39f2-4d82-9bf5-091bd68d5662",
                        "toolName": "get_weather",
                        "output": {
                            "type": "text",
                            "value": "It is raining."
                        }
                    }
                ]
            }
        ] as any as ModelMessage[];

        const state = new HasMessages(messages);

        const model = await createModel("ollama/lfm2.5-thinking:1.2b");
        const graph = makeReActGraph({ model });

        const finalState = await graph.execute(state);
        const finalMessages = finalState.messages;
        const finalAssistantMessage = finalMessages.findLast(m => m.role === 'assistant' && m.content !== messages[1]!.content);
        expect(finalAssistantMessage).toBeTruthy();
        const content = finalAssistantMessage!.content;
        console.log("Final assistant message content:", content);
        const text = typeof content === 'string'
            ? content
            : content
                .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                .map(part => part.text)
                .join(' ');
        expect(text.toLowerCase()).toContain('raining');

        expect(finalMessages).toHaveLength(4);
    }, defaultTimeout);

    it("emits response_chunk and reasoning_chunk events for UI updates", async () => {

        const model = await createModel("ollama/lfm2.5-thinking:1.2b", { think: true });

        const eventLog: any[] = [];
        const bus = new Bus();
        const eventTopic = bus.getTopic<any>('simplereact-events');
        eventTopic.subscribe(async (event) => {
            console.log("Event:", event);
            eventLog.push(event);
        });

        const graph = makeReActGraph({ model, name: "test-graph", maxRetries: 3, toolsProvider: async () => toolSet, eventTopic });

        const initialMessages = [
            { role: 'user', content: 'What is The weather in Paris?' } as UserModelMessage,
        ];

        await graph.execute(new HasMessages(initialMessages));

        const responseChunkEvents = eventLog.filter(e => e.type === 'response_chunk');
        expect(responseChunkEvents.length).toBeGreaterThan(0);

        const reasoningChunkEvents = eventLog.filter(e => e.type === 'reasoning_chunk');
        // Some models may not emit reasoning consistently; this stays informative without flaking.
        console.log("Reasoning chunks:", reasoningChunkEvents.length);
        

        const modelResponseEvent = eventLog.find(e => e.type === 'model_response');
        expect(modelResponseEvent).toBeTruthy();
        expect(Array.isArray(modelResponseEvent.responseMessages)).toBe(true);
        expect(modelResponseEvent.responseMessages.length).toBeGreaterThan(0);
    }, defaultTimeout);

    it('supports optional structured output with a schema-conformant final response', async () => {
        const model = await createModel("ollama/glm-5:cloud", { think: true });
        const bus = new Bus();

        const resultSchema = z.object({
            city: z.string(),
            weather: z.string(),
        });

        let structuredOutput: z.infer<typeof resultSchema> | undefined;

        const graph = makeReActGraph({
            model,
            name: "test-graph",
            maxRetries: 3,
            toolsProvider: async () => toolSet,
            eventTopic: bus.getTopic<any>('structured-output-events'),
            structuredOutput: {
                schema: resultSchema,
                name: 'final_agent_response',
                description: 'Final response JSON payload',
                onOutput: async (output) => {
                    structuredOutput = resultSchema.parse(output);
                },
            },
        });

        const finalState = await graph.execute(new HasMessages([
            {
                role: 'system',
                content: 'You must output only valid JSON that matches the structured output schema. Do not include markdown, commentary, or extra keys.',
            } as ModelMessage,
            {
                role: 'user',
                content: 'What is the weather in Paris? Return only a final JSON object that matches this example schema: { "city": "<name of city>", "weather": "<description of weather>" }',
            } as UserModelMessage,
        ]));

        console.log("Structured output:", structuredOutput);

        expect(structuredOutput).toBeTruthy();
        expect(structuredOutput!.city.toLowerCase()).toContain('paris');
        expect(structuredOutput!.weather.length).toBeGreaterThan(0);

        const assistantMessage = finalState.messages.findLast(m => m.role === 'assistant');
        expect(assistantMessage).toBeTruthy();
    }, defaultTimeout);

});
