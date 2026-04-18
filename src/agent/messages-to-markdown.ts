import type { AssistantModelMessage, UserModelMessage, SystemModelMessage, ModelMessage } from "ai"

const icons = {
    "assistant": "🤖",
    "user": "👤",
    "system": "⚙️",
    "tool": "🛠️",
}

/**
 * Convert messages to a chat-like markdown layout with clear visual separation.
 * Creates a readable conversation view suitable for summarization or context passing.
 * Strips low-level details (reasoning traces) to keep focus on conversation intent.
 * @param messages Array of messages to convert to markdown
 * @returns A formatted markdown string with spaced messages
 */
export function messagesToMarkdown(messages: ModelMessage[]): string {
    if (messages.length === 0) {
        return "";
    }

    const sections: string[] = [];

    for (const message of messages) {
        const icon = icons[message.role] || "💬";
        const roleLabel = message.role === "assistant" ? "Agent" : message.role.charAt(0).toUpperCase() + message.role.slice(1);
        const content = "content" in message ? message.content : "";

        // Main message block
        const messageBlock = `${icon} **${roleLabel}**\n\n${formatContent(content)}`;
        sections.push(messageBlock);

        // Tool calls (if any)
        const calledTools = message.role === "assistant" && "calledTools" in message ? message.calledTools : [];
        if (calledTools.length > 0) {
            const toolBlock = calledTools
                .map((tool) => `> ${icons.tool} Called **${tool.toolName}**\n> \`\`\`json\n> ${JSON.stringify(tool.input, null, 2).split("\n").join("\n> ")}\n> \`\`\``)
                .join("\n>\n");
            sections.push(toolBlock);
        }
    }

    return sections.join("\n\n---\n\n");
}

/**
 * Format message content for better readability in markdown.
 * Preserves code blocks and structure while ensuring clean spacing.
 */
function formatContent(content: string): string {
    if (!content) {
        return "*[empty message]*";
    }

    // Ensure code blocks remain readable
    if (content.includes("```")) {
        return content;
    }

    // For plain text, preserve original but trim excess whitespace
    return content.trim();
}
