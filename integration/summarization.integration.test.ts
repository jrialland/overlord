import { describe, expect, it } from "bun:test";
import { AgentManager } from "../src/agent/manager";
import { Bus } from "../src/bus";
import type { ReActEvent } from "../src/agent/react";
import type { SummarizationEvent } from "../src/agent/summarization-plugin";
import type { SessionRequest } from "../src/agent/types";
import type { AgentSessionEvent } from "../src/agent/agent";
import type { Topic } from "../src/bus";
import { Database } from "bun:sqlite";
import path from "path";

const defaultTimeout = 300000;

function waitForTurnCompletion(sessionEventTopic: Topic<AgentSessionEvent>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        sessionEventTopic.subscribe(async (event: AgentSessionEvent) => {
            if (event.type === "session_turn_complete") {
                resolve();
                return;
            }
            if (event.type === "session_error" || event.type === "session_fatal_error") {
                reject(new Error(event.error));
            }
        });
    });
}

describe("Summarization integration", () => {
    it("rotates conversation with summarization and emits lifecycle events", async () => {
        const workspace = process.cwd();
        const manager = new AgentManager(workspace);
        const bus = new Bus();

        const sessionEventTopic = bus.getTopic<AgentSessionEvent>("integration.summarization.session");
        const reactEventTopic = bus.getTopic<ReActEvent>("integration.summarization.react");
        const summarizationEventTopic = bus.getTopic<SummarizationEvent>("integration.summarization.events");

        const lifecycleEvents: SummarizationEvent[] = [];
        summarizationEventTopic.subscribe(async (event) => {
            lifecycleEvents.push(event);
        });

        let consumed = false;
        const sentinel = "INTEGRATION_SUMMARY_SENTINEL_42";
        const longPayload = `${sentinel} ${"x".repeat(1200)}`;

        const incomingRequestConsumer = (callback: (request: SessionRequest | undefined) => void): void => {
            if (consumed) {
                callback(undefined);
                return;
            }
            consumed = true;
            callback({ type: "user_message", payload: `Please acknowledge this marker: ${longPayload}` });
        };

        const turnDone = waitForTurnCompletion(sessionEventTopic);

        const { session } = manager.createAndRunAgent(
            "ollama/lfm2.5-thinking:1.2b",
            incomingRequestConsumer,
            {},
            {
                sessionEventTopic,
                reactEventTopic,
                startMode: "agent",
                timeoutMs: 170000,
                summarizationConfig: {
                    contextWindowSize: 120,
                    thresholdPercentage: 90,
                    summarizationEventTopic,
                    minimumResponseReserveTokens: 30,
                },
            }
        );

        await turnDone;

        const dbPath = path.join(workspace, ".overlord", "repository.db");
        const db = new Database(dbPath);
        try {
            const conversations = db.query(
                "select id, status from conversation where session_id = ? order by id asc"
            ).all(session.id) as Array<{ id: number; status: string }>;

            expect(conversations.length).toBeGreaterThan(1);
            expect(conversations.some((c) => c.status === "summarized")).toBe(true);

            const activeConversation = conversations.findLast((c) => c.status === "active");
            expect(activeConversation).toBeTruthy();

            const activeMessages = db.query(
                "select role, content from message where conversation_id = ? order by id asc"
            ).all(activeConversation!.id) as Array<{ role: string; content: string }>;

            expect(activeMessages.some((m) => m.role === "system" && m.content.includes("Conversation Summary"))).toBe(true);
            expect(activeMessages.some((m) => m.role === "user" && m.content.includes(sentinel))).toBe(true);

            expect(lifecycleEvents.some((e) => e.type === "summarization_start")).toBe(true);
            expect(lifecycleEvents.some((e) => e.type === "summarization_end" && e.success)).toBe(true);
        } finally {
            db.close();
        }
    }, defaultTimeout);
});
