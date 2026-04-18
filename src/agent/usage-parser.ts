/**
 * Utility functions for parsing AI SDK model usage/token data.
 * Handles variability in how different providers expose token counts.
 */

export function asPositiveNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}

function asFiniteNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return 0;
}

export type ParsedUsage = {
    input: number;
    output: number;
    total: number;
};

/**
 * Extract token usage from AI SDK response, handling multiple naming conventions.
 * Different providers expose usage data with different property names:
 * - OpenAI: inputTokens, outputTokens, totalTokens
 * - Anthropic: input_tokens, output_tokens
 * - Others: promptTokens, completionTokens, input, output, total
 */
export function extractUsage(usage: unknown): ParsedUsage | undefined {
    if (!usage || typeof usage !== "object") {
        return undefined;
    }
    const u = usage as Record<string, unknown>;
    const input =
        asFiniteNumber(u.inputTokens) ||
        asFiniteNumber(u.promptTokens) ||
        asFiniteNumber(u.input);
    const output =
        asFiniteNumber(u.outputTokens) ||
        asFiniteNumber(u.completionTokens) ||
        asFiniteNumber(u.output);
    const total = asFiniteNumber(u.totalTokens) || asFiniteNumber(u.total) || input + output;
    if (input <= 0 && output <= 0 && total <= 0) {
        return undefined;
    }
    return {
        input,
        output,
        total: total > 0 ? total : input + output,
    };
}
