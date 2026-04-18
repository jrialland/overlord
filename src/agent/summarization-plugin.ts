import { type LanguageModel, streamText, type ModelMessage } from "ai";
import type { AgentPlugin, PluginChain } from "./agent";
import type { AgentState } from "./agent";
import { Repository } from "../session/repository";
import { logger } from "../logging";
import { type Topic } from "../bus";
import type { ReActEvent } from "./react";
import { messagesToMarkdown } from "./messages-to-markdown";
import { estimateMessageTokens as estimateTokens } from "./token-estimation";
import { extractUsage } from "./usage-parser";
import type { AgentCommand } from "./types";

export type SummarizationEvent =
        | {
                type: "summarization_start";
                sessionId: string;
                conversationId: number;
                triggerCount: number;
                messageCount: number;
            }
        | {
                type: "summarization_end";
                sessionId: string;
                previousConversationId: number;
                newConversationId?: number;
                triggerCount: number;
                success: boolean;
                error?: string;
            };

/**
 * Configuration for the SummarizationPlugin.
 */
export interface SummarizationPluginConfig {
    /** Context window size of the model (tokens). */
    contextWindowSize?: number;
    /** Optional model identifier used to infer context size when explicit size is not provided. */
    modelName?: string;
    /** Threshold at which to trigger summarization (0-100). Default: 90. */
    thresholdPercentage?: number;
    /** Optional: Topic to listen for model response events (for accurate token counting). */
    reactEventTopic?: Topic<ReActEvent>;
    /** Optional custom summarizer for tests or alternative summary engines. */
    summarizer?: (messages: ModelMessage[]) => Promise<string>;
    /** Reserved token budget for the next model response when deciding pre-turn summarization. */
    minimumResponseReserveTokens?: number;
    /** Optional topic to emit summarization lifecycle events for UI updates. */
    summarizationEventTopic?: Topic<SummarizationEvent>;
}

/**
 * SummarizationPlugin tracks token usage throughout a conversation and automatically
 * summarizes the conversation when it approaches the model's context window limit.
 *
 * When the conversation size reaches the configured threshold (default 90% of context window),
 * the plugin creates a summary of the conversation and starts a new conversation
 * with the summary as context.
 */
export class SummarizationPlugin implements AgentPlugin {
    name = "SummarizationPlugin";
    description = "Automatically summarizes conversations when approaching context window limits.";

    private cumulativeTokens: number = 0;
    private thresholdTokens: number;
    private contextWindowSize: number;
    private lastTurnTokens: number | undefined;
    /** Absolute context fill in tokens from the last model step. Replaces additive tracking when available. */
    private lastContextFillTokens: number | undefined;
    private readonly summarizer?: (messages: ModelMessage[]) => Promise<string>;
    private readonly minimumResponseReserveTokens: number;
    private readonly summarizationEventTopic?: Topic<SummarizationEvent>;
    private skipAfterTurnSummarizationOnce: boolean = false;
    private pendingForcedSummarization: boolean = false;

    constructor(
        private readonly model: LanguageModel,
        private readonly repository: Repository,
        config: SummarizationPluginConfig
    ) {
        // contextWindowSize should be resolved by the caller; keep a safe local fallback.
        this.contextWindowSize = config.contextWindowSize ?? 32768;
        this.thresholdTokens =
            (config.thresholdPercentage ?? 90) * (this.contextWindowSize / 100);
        this.summarizer = config.summarizer;
        this.summarizationEventTopic = config.summarizationEventTopic;
        this.minimumResponseReserveTokens = Math.max(
            256,
            config.minimumResponseReserveTokens ?? Math.floor(this.contextWindowSize * 0.1)
        );

        // Subscribe to model response events for accurate token usage
        if (config.reactEventTopic) {
            config.reactEventTopic.subscribe(async (event) => {
                if (event.type === 'model_response') {
                    // contextFillTokens = last step's inputTokens = absolute context window occupancy.
                    // This is the ground truth: it includes system prompt, tools, all messages.
                    const contextFill = (event as { contextFillTokens?: number }).contextFillTokens;
                    if (contextFill !== undefined && contextFill > 0) {
                        this.lastContextFillTokens = contextFill;
                        logger.debug(
                            {
                                contextFillTokens: contextFill,
                                thresholdTokens: this.thresholdTokens,
                            },
                            "Exact context fill captured from model response"
                        );
                        return;
                    }
                    // Fallback: provider did not report step-level usage
                    const usage = extractUsage(event.usage) ?? extractUsage(event.totalUsage);
                    if (usage) {
                        this.lastTurnTokens = usage.total;
                        logger.debug(
                            {
                                turnTokens: usage.total,
                                thresholdTokens: this.thresholdTokens,
                            },
                            "Token usage captured from model response (fallback, no step-level data)"
                        );
                    }
                }
            });
        }
    }

    /**
     * Reset token tracking at the start of a new conversation.
     */
    async beforeConversation(state: AgentState, chain: PluginChain): Promise<AgentState> {
        this.cumulativeTokens = this.estimateMessageTokens(state.messages);
        this.lastTurnTokens = undefined;
        return chain.doNextBeforeConversation(state);
    }

    /**
     * Proactively summarize before executing a new turn when we're close to window exhaustion.
     */
    async beforeTurn(state: AgentState, chain: PluginChain): Promise<AgentState> {
        const messageTokens = this.estimateMessageTokens(state.messages);
        this.cumulativeTokens = Math.max(this.cumulativeTokens, messageTokens);
        const estimatedNextTurnTotal = this.cumulativeTokens + this.minimumResponseReserveTokens;

        const shouldSummarize =
            this.pendingForcedSummarization ||
            this.cumulativeTokens >= this.thresholdTokens ||
            estimatedNextTurnTotal >= this.contextWindowSize;

        if (shouldSummarize) {
            if (this.pendingForcedSummarization) {
                logger.info({ stage: "before_turn" }, "Forced summarization triggered by command");
            } else {
                logger.info(
                    {
                        stage: "before_turn",
                        cumulativeTokens: this.cumulativeTokens,
                        thresholdTokens: this.thresholdTokens,
                        reserveTokens: this.minimumResponseReserveTokens,
                        contextWindowSize: this.contextWindowSize,
                        estimatedNextTurnTotal,
                    },
                    "Pre-turn token check reached summarization threshold"
                );
            }
            this.pendingForcedSummarization = false;

            try {
                const pendingUserMessage = state.lastMessage?.role === "user"
                    ? [state.lastMessage]
                    : [];
                await this.summarizeAndRotateConversation(state, pendingUserMessage);
                this.skipAfterTurnSummarizationOnce = true;
            } catch (error) {
                logger.error(
                    { error },
                    "Failed to summarize before turn, continuing without summarization"
                );
            }
        }

        return chain.doNextBeforeTurn(state);
    }

    /**
     * Check token usage after each turn and trigger summarization if needed.
     */
    async afterTurn(state: AgentState, chain: PluginChain): Promise<AgentState> {
        if (this.lastContextFillTokens !== undefined) {
            // Exact measurement: the model told us how many input tokens it actually consumed.
            // This is the real context window fill — no estimation needed.
            this.cumulativeTokens = this.lastContextFillTokens;
            logger.info(
                {
                    contextFillTokens: this.lastContextFillTokens,
                    cumulativeTokens: this.cumulativeTokens,
                    thresholdTokens: this.thresholdTokens,
                    percentage: Math.round((this.cumulativeTokens / this.contextWindowSize) * 100),
                },
                "Token usage check (exact)"
            );
            this.lastContextFillTokens = undefined;
        } else {
            // Provider did not report step-level usage. Fall back to additive estimation.
            const turnTokens = this.lastTurnTokens ?? this.estimateMessageTokens(state.lastMessage);
            this.cumulativeTokens += turnTokens;
            this.cumulativeTokens = Math.max(this.cumulativeTokens, this.estimateMessageTokens(state.messages));
            logger.info(
                {
                    turnTokens,
                    cumulativeTokens: this.cumulativeTokens,
                    thresholdTokens: this.thresholdTokens,
                    percentage: Math.round((this.cumulativeTokens / this.contextWindowSize) * 100),
                    estimated: true,
                },
                "Token usage check (estimated — provider did not report step-level usage)"
            );
        }
        this.lastTurnTokens = undefined;

        if (this.cumulativeTokens >= this.thresholdTokens) {
            if (this.skipAfterTurnSummarizationOnce) {
                this.skipAfterTurnSummarizationOnce = false;
                return chain.doNextAfterTurn(state);
            }
            logger.info(
                { cumulativeTokens: this.cumulativeTokens, threshold: this.thresholdTokens },
                "Token threshold reached, triggering summarization"
            );

            try {
                await this.summarizeAndRotateConversation(state);
            } catch (error) {
                logger.error(
                    { error },
                    "Failed to summarize conversation, continuing without summarization"
                );
                // Don't fail the agent, just log and continue
            }
        }

        return chain.doNextAfterTurn(state);
    }

    async onCommand(state: AgentState, command: AgentCommand, chain: PluginChain): Promise<void> {
        if (command.type === 'trigger_summarization') {
            this.pendingForcedSummarization = true;
            logger.debug({ sessionId: state.sessionId }, 'Summarization scheduled by command');
        }
        await chain.doNextOnCommand(state, command);
    }

    /**
     * Summarizes the current conversation and creates a new one with the summary.
     */
    private async summarizeAndRotateConversation(
        state: AgentState,
        carryForwardMessages: ModelMessage[] = []
    ): Promise<void> {
        const currentMessages = state.messages;
        if (currentMessages.length === 0) {
            return;
        }

        const previousConversationId = state.conversationId;
        const triggerCount = this.incrementTriggerCount(state);

        await this.summarizationEventTopic?.publish({
            type: "summarization_start",
            sessionId: state.sessionId,
            conversationId: previousConversationId,
            triggerCount,
            messageCount: currentMessages.length,
        });
        try {
            const preservedSystemMessages = this.getLeadingSystemMessages(currentMessages);

            logger.info(
                { messageCount: currentMessages.length },
                "Summarizing conversation"
            );

            const summaryText = await this.generateSummary(currentMessages);

            logger.info(
                { summaryLength: summaryText.length },
                "Conversation summary generated"
            );

            // Get the current session ID
            const sessionId = state.sessionId ? parseInt(state.sessionId, 10) : 0;

            if (!sessionId || sessionId === 0) {
                throw new Error("Session ID not set in state");
            }

            // Preserve initial system guidance, then append a compact continuity anchor.
            state.messages = [
                ...preservedSystemMessages,
                {
                    role: "system",
                    content: this.buildContinuationSystemMessage(summaryText),
                },
                ...carryForwardMessages,
            ];

            if (previousConversationId > 0) {
                this.repository.updateConversationStatus(previousConversationId, "summarized");
            }

            const createdConversationId = this.repository.createConversation(sessionId, "active");

            // Update conversation ID in state
            state.conversationId = createdConversationId;

            for (const message of state.messages) {
                if (typeof message.content !== "string") {
                    continue;
                }
                this.repository.addMessageToConversationById(
                    createdConversationId,
                    message.role,
                    message.content
                );
            }

            // Reset token counter for the new conversation
            // Use the summarized messages length as a seed estimate; the next real turn will
            // replace this with an exact measurement from the model.
            const summaryTokens = this.estimateMessageTokens(state.messages);
            this.cumulativeTokens = summaryTokens;
            this.lastTurnTokens = undefined;
            this.lastContextFillTokens = undefined;

            logger.info(
                {
                    previousConversationId,
                    newConversationId: createdConversationId,
                },
                "Conversation rotated after summarization"
            );

            await this.summarizationEventTopic?.publish({
                type: "summarization_end",
                sessionId: state.sessionId,
                previousConversationId,
                newConversationId: createdConversationId,
                triggerCount,
                success: true,
            });
        } catch (error) {
            await this.summarizationEventTopic?.publish({
                type: "summarization_end",
                sessionId: state.sessionId,
                previousConversationId,
                triggerCount,
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    private incrementTriggerCount(state: AgentState): number {
        const key = "summarization.triggerCount";
        const current = Number(state.pluginData[key] ?? 0);
        const next = Number.isFinite(current) ? current + 1 : 1;
        state.pluginData[key] = next;
        return next;
    }

    private async generateSummary(messages: ModelMessage[]): Promise<string> {
        if (this.summarizer) {
            return this.summarizer(messages);
        }

        const summaryPrompt = this.buildSummaryPrompt(messages);
        const summaryResult = await streamText({
            model: this.model,
            maxOutputTokens: 700,
            messages: [
                {
                    role: "system",
                    content:
                        "You summarize software-engineering conversations. " +
                        "Produce concise, factual context needed to continue the task.",
                },
                {
                    role: "user",
                    content: summaryPrompt,
                },
            ],
        });

        return (await summaryResult.text).trim();
    }

    private buildContinuationSystemMessage(summaryText: string): string {
        return [
            "You are continuing an existing session.",
            "Use the summary below as compressed context from earlier turns.",
            "",
            "Conversation Summary:",
            summaryText,
            "",
            "Continue helping the user while preserving earlier decisions and constraints.",
        ].join("\n");
    }

    /**
     * Preserve initial system prompts (typically index 0) across conversation rotations.
     */
    private getLeadingSystemMessages(messages: ModelMessage[]): ModelMessage[] {
        const preserved: ModelMessage[] = [];
        for (const message of messages) {
            if (message.role !== "system") {
                break;
            }
            preserved.push(message);
        }
        return preserved;
    }

    /**
     * Estimates token count for one or more messages using a tokenizer-backed transcript
     * representation, falling back to the old chars/4 heuristic only when tokenization fails.
     *
     * This remains a cold-start seed until the provider reports exact step-level usage.
     */
    private estimateMessageTokens(message: ModelMessage | ModelMessage[]): number {
        return estimateTokens(message);
    }

    /**
     * Builds a prompt for the model to summarize the conversation.
     */
    private buildSummaryPrompt(messages: ModelMessage[]): string {
        const markdown = messagesToMarkdown(messages.slice(-100));
        return [
            "Summarize this conversation for continuation in a constrained context window.",
            "Include: objective, completed work, decisions, unresolved items, and constraints.",
            "Keep it compact but concrete.",
            "",
            markdown,
        ].join("\n");
    }

}
