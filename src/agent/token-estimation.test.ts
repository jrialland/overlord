import { describe, expect, it } from "bun:test";
import { countTokens } from "gpt-tokenizer";
import type { ModelMessage } from "ai";
import {
    estimateMessageTokens,
    estimateMessageTokensHeuristically,
    serializeMessagesForTokenEstimation,
} from "./token-estimation";

describe("token estimation", () => {
    it("serializes message roles and text content for token counting", () => {
        const messages: ModelMessage[] = [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Summarize the repo." },
        ];

        expect(serializeMessagesForTokenEstimation(messages)).toBe(
            "[system]\nYou are helpful.\n\n[user]\nSummarize the repo.",
        );
    });

    it("uses gpt-tokenizer for the primary estimate", () => {
        const message: ModelMessage = {
            role: "user",
            content: "TypeScript interfaces are not emitted at runtime.",
        };

        const serialized = serializeMessagesForTokenEstimation(message);
        expect(estimateMessageTokens(message)).toBe(countTokens(serialized));
    });

    it("falls back to text extraction for structured content blocks", () => {
        const message = {
            role: "assistant",
            content: [
                { type: "text", text: "First block." },
                { type: "text", text: "Second block." },
            ],
        } as ModelMessage;

        expect(serializeMessagesForTokenEstimation(message)).toContain("First block.\nSecond block.");
        expect(estimateMessageTokens(message)).toBeGreaterThan(0);
        expect(estimateMessageTokensHeuristically(message)).toBeGreaterThan(0);
    });
});
