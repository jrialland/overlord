import { countTokens } from "gpt-tokenizer";
import type { ModelMessage } from "ai";

function toMessageArray(message: ModelMessage | ModelMessage[]): ModelMessage[] {
    return Array.isArray(message) ? message : [message];
}

function blockToText(block: unknown): string {
    if (typeof block === "string") {
        return block;
    }

    if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
        return block.text;
    }

    try {
        return JSON.stringify(block);
    } catch {
        return String(block);
    }
}

function messageToText(message: ModelMessage): string {
    if (typeof message.content === "string") {
        return message.content;
    }

    if (!Array.isArray(message.content)) {
        return "";
    }

    return message.content
        .map((block) => blockToText(block))
        .filter((value) => value.length > 0)
        .join("\n");
}

export function serializeMessagesForTokenEstimation(message: ModelMessage | ModelMessage[]): string {
    return toMessageArray(message)
        .map((entry) => `[${entry.role}]\n${messageToText(entry)}`)
        .join("\n\n");
}

export function estimateMessageTokensHeuristically(message: ModelMessage | ModelMessage[]): number {
    const messages = toMessageArray(message);
    let totalTokens = 0;

    for (const entry of messages) {
        const text = messageToText(entry);
        totalTokens += Math.ceil(text.length / 4);
    }

    return totalTokens;
}

export function estimateMessageTokens(message: ModelMessage | ModelMessage[]): number {
    const serialized = serializeMessagesForTokenEstimation(message);
    if (!serialized) {
        return 0;
    }

    try {
        return countTokens(serialized);
    } catch {
        return estimateMessageTokensHeuristically(message);
    }
}
