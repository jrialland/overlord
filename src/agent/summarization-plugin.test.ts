import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SummarizationPlugin } from "./summarization-plugin";
import { AgentState, type PluginChain } from "./agent";
import { Repository } from "../session/repository";
import { Bus } from "../bus";
import type { ReActEvent } from "./react";
import type { LanguageModel } from "ai";
import type { SummarizationEvent } from "./summarization-plugin";
import fs from "fs";
import path from "path";
import os from "os";

const defaultTimeout = 15000;

const fakeModel = {
    provider: "test",
    modelId: "test-model",
} as unknown as LanguageModel;

describe("SummarizationPlugin", () => {
    let tempDir: string;
    let repository: Repository;
    let sessionId: number;
    let reactBus: Bus;

    beforeEach(async () => {
        // Create temporary workspace
        tempDir = path.join(os.tmpdir(), `summarization-test-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        // Initialize repository and session
        repository = new Repository(tempDir);
        const session = repository.createSession("ollama/llama2", {});
        sessionId = session.id;

        // Create event bus for token tracking
        reactBus = new Bus();
    });

    afterEach(() => {
        repository.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function createMockChain(state: AgentState): PluginChain {
        return {
            doNextBeforeConversation: async (s: AgentState) => s,
            doNextAfterConversation: async (s: AgentState) => s,
            doNextBeforeTurn: async (s: AgentState) => s,
            doNextAfterTurn: async (s: AgentState) => s,
            doNextGetToolSet: async () => ({}),
            doNextGetGraph: async () => {
                throw new Error("Not implemented in test");
            },
            stateGetter: () => state,
        };
    }

    function createState(messages: Array<{ role: "user" | "assistant" | "system"; content: string }>): AgentState {
        const state = new AgentState();
        state.messages = [...messages];
        state.model = "ollama/llama2";
        state.modelConfiguration = {};
        state.mode = "agent" as any;
        state.isSubAgent = false;
        state.sessionId = String(sessionId);
        state.conversationId = repository.ensureConversation(sessionId);
        state.turnCount = 0;
        state.remainingRaphIterations = 0;
        return state;
    }

    it("should track token usage", async () => {
        const reactTopic = reactBus.getTopic<ReActEvent>("react-events");
        const config = {
            contextWindowSize: 4096,
            thresholdPercentage: 90,
            reactEventTopic: reactTopic,
            summarizer: async () => "summary",
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);
        const state = createState([{ role: "user", content: "Hello" }]);

        const mockChain = createMockChain(state);

        // Initialize plugin
        await plugin.beforeConversation(state, mockChain);

        // Publish token usage event
        await reactTopic.publish({
            type: "model_response",
            finishReason: "stop",
            usage: { input: 100, output: 50 },
            totalUsage: { input: 100, output: 50 },
            responseMessages: [],
            steps: [],
        });

        // Add assistant response
        state.messages.push({
            role: "assistant",
            content: "Hello, how can I help?",
        });

        // Check that plugin doesn't crash on afterTurn
        const resultState = await plugin.afterTurn(state, mockChain);

        expect(resultState).toBeDefined();
        expect(resultState.conversationId).toBe(state.conversationId);
    }, defaultTimeout);

    it("should have correct configuration", async () => {
        const config = {
            contextWindowSize: 8192,
            thresholdPercentage: 85,
            summarizer: async () => "summary",
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);

        expect(plugin.name).toBe("SummarizationPlugin");
        expect(plugin.description).toContain("conversation");
    }, defaultTimeout);

    it("should estimate message tokens correctly", async () => {
        const config = {
            contextWindowSize: 4096,
            thresholdPercentage: 90,
            summarizer: async () => "summary",
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);

        // We can't directly test the private estimateMessageTokens method,
        // but we can verify the plugin works with messages of various sizes
        const state = createState([{ role: "user", content: "a".repeat(4000) }]);

        const mockChain = createMockChain(state);

        await plugin.beforeConversation(state, mockChain);
        const result = await plugin.afterTurn(state, mockChain);

        expect(result).toBeDefined();
    }, defaultTimeout);

    it("should rotate to a new conversation when threshold is reached", async () => {
        const config = {
            contextWindowSize: 100,
            thresholdPercentage: 90,
            summarizer: async () => "Condensed summary",
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);
        const state = createState([
            { role: "system", content: "You are helpful." },
            { role: "user", content: "a".repeat(500) },
        ]);

        const initialConversationId = state.conversationId;
        const mockChain = createMockChain(state);

        await plugin.beforeConversation(state, mockChain);
        await plugin.afterTurn(state, mockChain);

        expect(state.conversationId).not.toBe(initialConversationId);
        expect(state.messages).toHaveLength(2);
        expect(state.messages[0]?.role).toBe("system");
        expect(String(state.messages[0]?.content)).toContain("You are helpful.");
        expect(state.messages[1]?.role).toBe("system");
        expect(String(state.messages[1]?.content)).toContain("Conversation Summary");

        const activeConversationId = repository.ensureConversation(sessionId);
        expect(activeConversationId).toBe(state.conversationId);
        expect(state.pluginData["summarization.triggerCount"]).toBe(1);
    }, defaultTimeout);

    it("should proactively summarize before turn when next response may exceed context window", async () => {
        const config = {
            contextWindowSize: 100,
            thresholdPercentage: 90,
            minimumResponseReserveTokens: 25,
            summarizer: async () => "Condensed summary",
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);
        const state = createState([
            { role: "system", content: "You are helpful." },
            { role: "user", content: "a".repeat(300) },
        ]);

        const initialConversationId = state.conversationId;
        const mockChain = createMockChain(state);

        await plugin.beforeConversation(state, mockChain);
        await plugin.beforeTurn(state, mockChain);

        expect(state.conversationId).not.toBe(initialConversationId);
        expect(state.messages).toHaveLength(3);
        expect(state.messages[0]?.role).toBe("system");
        expect(String(state.messages[0]?.content)).toContain("You are helpful.");
        expect(state.messages[1]?.role).toBe("system");
        expect(String(state.messages[1]?.content)).toContain("Conversation Summary");
        expect(state.messages[2]?.role).toBe("user");
        expect(String(state.messages[2]?.content)).toContain("a");
    }, defaultTimeout);

    it("should integrate with plugin chain", async () => {
        const config = {
            contextWindowSize: 4096,
            thresholdPercentage: 90,
            summarizer: async () => "summary",
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);

        // Verify plugin implements AgentPlugin interface
        expect(typeof plugin.beforeConversation).toBe("function");
        expect(typeof plugin.afterTurn).toBe("function");
        expect(plugin.name).toBe("SummarizationPlugin");
        expect(plugin.description).toBeDefined();
    }, defaultTimeout);

    it("should emit summarization lifecycle events when triggered", async () => {
        const summarizationBus = new Bus();
        const summarizationTopic = summarizationBus.getTopic<SummarizationEvent>("summarization-events");
        const events: SummarizationEvent[] = [];
        summarizationTopic.subscribe(async (event) => {
            events.push(event);
        });

        const config = {
            contextWindowSize: 100,
            thresholdPercentage: 90,
            summarizer: async () => "Condensed summary",
            summarizationEventTopic: summarizationTopic,
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);
        const state = createState([
            { role: "system", content: "You are helpful." },
            { role: "user", content: "a".repeat(500) },
        ]);

        const mockChain = createMockChain(state);

        await plugin.beforeConversation(state, mockChain);
        await plugin.afterTurn(state, mockChain);

        expect(events.length).toBe(2);
        expect(events[0]?.type).toBe("summarization_start");
        expect(events[1]?.type).toBe("summarization_end");
        const endEvent = events[1];
        expect(endEvent?.type).toBe("summarization_end");
        if (endEvent && endEvent.type === "summarization_end") {
            expect(endEvent.success).toBe(true);
        }
    }, defaultTimeout);

    it("should increment trigger count across multiple summarizations", async () => {
        const config = {
            contextWindowSize: 100,
            thresholdPercentage: 90,
            summarizer: async () => "Condensed summary",
        };

        const plugin = new SummarizationPlugin(fakeModel, repository, config);
        const state = createState([
            { role: "system", content: "You are helpful." },
            { role: "user", content: "a".repeat(500) },
        ]);

        const mockChain = createMockChain(state);

        await plugin.beforeConversation(state, mockChain);
        await plugin.afterTurn(state, mockChain);
        expect(state.pluginData["summarization.triggerCount"]).toBe(1);

        state.messages.push({ role: "user", content: "b".repeat(500) });
        await plugin.afterTurn(state, mockChain);
        expect(state.pluginData["summarization.triggerCount"]).toBe(2);
    }, defaultTimeout);
});
