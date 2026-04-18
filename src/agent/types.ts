import { type ModelMessage, type UserModelMessage, type SystemModelMessage } from "ai"
import { type MCPConfig } from "../mcp/types";

/**
 * Commands that can be sent to a running agent from an external caller (e.g. a UI).
 * Delivered via the commandTopic injected into AgentProcess.
 */
export type AgentCommand =
    | { type: 'set_ralph_iterations'; value: number }
    | { type: 'trigger_summarization' };

/**
 * Mutable container for conversation messages with convenience accessors.
 */
export class HasMessages {

    constructor(public messages: ModelMessage[]) {
    }

    /**
     * Appends model or user messages to the current state.
     */
    appendMessages(messages: ModelMessage[]): void {
        this.messages.push(...messages);
    }

    setFirstSystemMessage(content: string): void {
        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i]!;
            if (msg.role === 'system') {
                this.messages[i] = {
                    ...msg,
                    content,
                };
                return;
            }
        }
        // If no system message exists, prepend one
        this.messages.unshift({
            role: 'system',
            content,
        });
    }

    /**
     * Returns a deep-cloned payload safe for serialization or replay.
     */
    toJSON(): { messages: ModelMessage[] } {
        // Deep clone to keep serialization/replay detached from the in-memory state object.
        return {
            messages: JSON.parse(JSON.stringify(this.messages)) as ModelMessage[],
        };
    }

    /**
     * Rehydrates a HasMessages instance from serialized JSON data.
     */
    static fromJSON(value: { messages: ModelMessage[] }): HasMessages {
        return new HasMessages(JSON.parse(JSON.stringify(value.messages)) as ModelMessage[]);
    }

    /**
     * Returns the last message in the conversation.
     */
    get lastMessage(): ModelMessage {
        if (this.messages.length === 0) {
            throw new Error("No messages available");
        }
        return this.messages[this.messages.length - 1]!;
    }

    /**
     * Returns the most recent user-authored message, if any.
     */
    get lastUserMessage(): UserModelMessage | undefined {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const msg = this.messages[i]!;
            if (msg.role === 'user') {
                return msg as UserModelMessage;
            }
        }
        return undefined;
    }

    /**
     * Returns the first system message used to prime the conversation, if present.
     */
    get firstSystemMessage(): SystemModelMessage | undefined {
        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i]!;
            if (msg.role === 'system') {
                return msg as SystemModelMessage;
            }
        }
        return undefined;
    }
}

/**
 * Incoming request consumed by a running agent.
 * Each variant carries its own typed payload.
 */
export type SessionRequest =
    | { type: 'user_message'; payload: string }
    | { type: 'subagent_task'; payload: string };

/**
 * Session startup configuration for model selection, tools, and optional MCP servers.
 */
export interface SessionConfiguration {
    workspacePath: string;
    model: string,
    reasoning?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    modelConfig?: Record<string, unknown>;
    mcp?: MCPConfig,
}