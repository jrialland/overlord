"""
Custom ChatOpenAI for Moonshot models (mainly tested with kimi-k2.5). Moonshot's API is mostly compatible with OpenAI's, but has a few differences that require a custom implementation of ChatOpenAI. The main differences are:
- Force temperature to 1.0 for the kimi-k2.5 model, as mandated by Moonshot's API docs.
- Moonshot's API returns tool call thinking content in a separate field called "reasoning_content", instead of in the message content. This requires some special handling to make it work with LangChain's tool calling.
"""

from typing import (Any, Callable, Dict, List, Literal, Optional, Sequence,
                    Tuple, Type, Union)

from langchain_community.adapters.openai import convert_dict_to_message
from langchain_community.chat_models.openai import \
    ChatOpenAI as ChatOpenAICommunity
from langchain_core.language_models import LanguageModelInput
from langchain_core.messages import AIMessage, BaseMessage, ChatMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from langchain_core.utils import (convert_to_secret_str, get_from_dict_or_env,
                                  pre_init)
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import BaseModel

MOONSHOT_SERVICE_URL_BASE = "https://api.moonshot.ai/v1"

REASONING_CONTENT_KEYS = (
    "reasoning_content",
)  # some other models may also use "reasoning" or "reasoning_details"


class ChatMoonshot(ChatOpenAICommunity):
    """
    A custom ChatOpenAI for models served at moonshot.ai
    """

    @pre_init
    def validate_environment(cls, values: Dict) -> Dict:  # type: ignore[type-arg] # FIX ME
        """Validate that the environment is set up correctly."""
        values["moonshot_api_key"] = convert_to_secret_str(
            get_from_dict_or_env(
                values,
                ["moonshot_api_key", "api_key", "openai_api_key"],
                "MOONSHOT_API_KEY",
            )
        )

        try:
            import openai

        except ImportError:
            raise ImportError(
                "Could not import openai python package. "
                "Please install it with `pip install openai`."
            )

        client_params = {
            "api_key": values["moonshot_api_key"].get_secret_value(),
            "base_url": values["base_url"]
            if "base_url" in values
            else MOONSHOT_SERVICE_URL_BASE,
        }

        if not values.get("client"):
            values["client"] = openai.OpenAI(**client_params).chat.completions
        if not values.get("async_client"):
            values["async_client"] = openai.AsyncOpenAI(
                **client_params
            ).chat.completions

        # if model is kimi-k2.5, set temperature to 1.0, mandated per API docs for that model
        model = values.get("model", "")
        if not model:
            model = values["model"] = "kimi-k2.5"

        if model == "kimi-k2.5":
            values["model_kwargs"]["temperature"] = 1.0

        return values

    def bind_tools(
        self,
        tools: Sequence[Union[Dict[str, Any], Type[BaseModel], Callable, BaseTool]],  # type: ignore[type-arg] # FIX ME
        *,
        tool_choice: Optional[  # type: ignore[type-arg] # FIX ME
            Union[dict, str, Literal["auto", "any", "none"], bool]
        ] = None,
        **kwargs: Any,
    ) -> Runnable[LanguageModelInput, AIMessage]:
        formatted_tools = [convert_to_openai_tool(tool) for tool in tools]
        return self.bind(tools=formatted_tools, **kwargs)

    def _create_chat_result(self, response: Union[dict, BaseModel]) -> ChatResult:  # type: ignore[type-arg] # FIX ME
        generations = []
        if not isinstance(response, dict):
            response = response.model_dump()
        for res in response["choices"]:
            message: ChatMessage = convert_dict_to_message(res["message"])  # type: ignore[assignment] # FIX ME

            # put 'reasoning_content' in content, so that it is available in tool calls. This is a workaround for the fact that Moonshot's API puts tool call thinking content in a separate field instead of the message content, which breaks standard OpenAI API usage
            for k in REASONING_CONTENT_KEYS:
                if k in res:
                    message.additional_kwargs[k] = res[k]
                    if not message.content:
                        message.content = res[k]

            generation_info = dict(finish_reason=res.get("finish_reason"))
            if "logprobs" in res:
                generation_info["logprobs"] = res["logprobs"]
            gen = ChatGeneration(
                message=message,
                generation_info=generation_info,
            )
            generations.append(gen)
        token_usage = response.get("usage", {})
        llm_output = {
            "token_usage": token_usage,
            "model_name": self.model_name,
            "system_fingerprint": response.get("system_fingerprint", ""),
        }
        return ChatResult(generations=generations, llm_output=llm_output)

    def _create_message_dicts(
        self, messages: List[BaseMessage], stop: Optional[List[str]]
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """Create message dicts for API call, adding reasoning_content for Moonshot."""
        message_dicts, params = super()._create_message_dicts(messages, stop)

        # Moonshot requires reasoning_content for AIMessages with tool_calls
        # when thinking is enabled
        for msg_dict, msg in zip(message_dicts, messages):
            if isinstance(msg, AIMessage):
                # AIMessage with tool_calls needs reasoning_content
                # when thinking is enabled
                if msg.tool_calls and not msg_dict.get("reasoning_content"):
                    for k in REASONING_CONTENT_KEYS:
                        msg_dict[k] = msg.additional_kwargs.get(k, "?")
                    # remove content to avoid confusion, since Moonshot expects reasoning_content instead of content for tool call messages
                    msg_dict.pop("content", None)
        return message_dicts, params