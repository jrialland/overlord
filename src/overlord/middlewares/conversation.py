"""
This module defines a ConversationShrinkerMiddleware that can be used in the agent's middleware stack to clean up the conversation history by
stripping out large tool call results and file/image content from messages, in order to avoid hitting context size limits too fast
or needing to summarize too often.
"""

from typing import Any, override

from langchain.agents.middleware.types import (AgentMiddleware, AgentState,
                                               ContextT)
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime
from loguru import logger


class ConversationShrinkerMiddleware(
    AgentMiddleware[AgentState[Any], None, None]
):  # type: ignore  # FIX ME # FIX ME # FIX ME
    """
    On states that have a 'messages' key, this middleware 'cleans up' some messages in order to reduce the context size, avoiding summarization.
    - 1) result of tool calls that exceed a certain threshold are replaced by a placeholder message
    - 2) tool calls and HumanMessages that contain file or image content are replaced by placeholder messages
    """

    def __init__(
        self,
        donttouch_n_last_messages: int = 20,
        tool_call_threshold: int = 512,
    ):
        self.donttouch_n_last_messages = donttouch_n_last_messages
        self.tool_call_threshold = tool_call_threshold
        self.last_index = 0

    def _cleanup_tool_call(self, message: ToolMessage) -> ToolMessage:
        size = len(message.content)
        if size > self.tool_call_threshold:
            message.content = (
                f"[Tool call result of size {size} was stripped out for brevity]"
            )
            logger.debug(f"stripped {size} characters from tool call result")
        return message

    def _cleanup_message_with_data(self, message: HumanMessage) -> HumanMessage:
        if isinstance(message.content, list):
            for part in message.content:
                if isinstance(part, dict):
                    part_type = part.get("type")
                    if part_type == "image_url" and part.get(
                        "image_url", ""
                    ).startswith("data:"):
                        size = len(part["image_url"])
                        part["image_url"] = (
                            "[Image content was stripped out for brevity]"
                        )
                        logger.debug(f"stripped {size} characters from image content")
                    elif part_type == "input_audio" and "data" in part:
                        size = len(part["data"])
                        part["data"] = "[Audio content was stripped out for brevity]"
                        logger.debug(f"stripped {size} characters from audio content")
                    # TODO: add more types of content as needed
        return message

    def _cleanup_tool_call_with_data(self, message: AIMessage) -> AIMessage:
        if message.tool_calls:
            for tool_call in message.tool_calls:
                args = tool_call.get("args", {})
                # evaluate the size of args by summing the length of string values in args. This is a heuristic and may need to be improved in the future to better capture the actual size of the content.
                size = sum(len(str(value)) for value in args.values())
                if size > self.tool_call_threshold:
                    tool_call["args"] = {
                        key: "[Content was stripped out for brevity]"
                        if len(str(value)) > self.tool_call_threshold / len(args)
                        else value
                        for key, value in args.items()
                    }
                    logger.debug(f"stripped {size} characters from tool call args")
        return message
    

    @override
    def before_model(
        self, state: AgentState[Any], runtime: Runtime[ContextT]
    ) -> dict[str, Any] | None:
        messages = state.get("messages", [])
        if len(messages) > self.donttouch_n_last_messages:
            i = len(messages) - self.donttouch_n_last_messages
            for j in range(i, self.last_index, -1):
                message = messages[j]
                if isinstance(message, ToolMessage):
                    messages[j] = self._cleanup_tool_call(message)
                elif isinstance(message, HumanMessage):
                    messages[j] = self._cleanup_message_with_data(message)
                elif isinstance(message, AIMessage):
                    messages[j] = self._cleanup_tool_call_with_data(message)
            self.last_index = i
        return {"messages": messages}