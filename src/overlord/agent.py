from __future__ import annotations

import datetime
import re
import shutil
from pathlib import Path
from typing import Any, Awaitable, Callable, override

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain.agents.middleware import (ModelRetryMiddleware, Runtime,
                                         SummarizationMiddleware)
from langchain.agents.middleware.types import AgentMiddleware, ContextT
from langchain_core.messages import (AIMessage, BaseMessage, HumanMessage,
                                     SystemMessage, ToolMessage)
from langchain_core.tools import BaseTool, tool
from langchain_core.tools.base import ToolException
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.config import get_stream_writer
from langgraph.graph.state import CompiledStateGraph  # type: ignore # FIX ME # FIX ME
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command
from loguru import logger
from pydantic import BaseModel, Field

from overlord.patterns.ralph_mode import RalphMode
from overlord.rag import RagIndex

from .configuration import Configuration  # type: ignore # FIX ME # FIX ME
from .middlewares.conversation import \
    ConversationShrinkerMiddleware  # type: ignore # FIX ME # FIX ME
from .prompt import SystemPromptGenerator  # type: ignore # FIX ME # FIX ME
from .utils.archives import extract_archive  # type: ignore # FIX ME # FIX ME
from .utils.avatar import generate_avatar_image
from .utils.naming import make_bot_name  # type: ignore # FIX ME # FIX ME


# -------------------------------------------------------------------------------
class AgentState(BaseModel):
    messages: list[BaseMessage] = Field(
        default_factory=list, description="The message history of the agent."
    )
    current_skill: str | None = Field(
        default=None, description="The currently active skill of the agent, if any."
    )
    next_skill: str | None = Field(
        default=None,
        description="The next skill to activate, if any. This can be set by the agent's reasoning process to indicate which skill should be activated next.",
    )

    debug: bool = Field(
        default=False, description="Whether the agent is in debug mode."
    )

    workspace_path: Path | None = Field(
        ..., description="Path to the agent's workspace directory."
    )

    nickname: str | None = Field(default=None, description="Nickname for the agent.")

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)

    def set(self, key: str, value: Any) -> None:
        setattr(self, key, value)

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)

    def __setitem__(self, key: str, value: Any) -> None:
        setattr(self, key, value)

    def __contains__(self, key: str) -> bool:
        return hasattr(self, key)


# -------------------------------------------------------------------------------
class CustomPromptMiddleware(AgentMiddleware[AgentState, None, None]):  # type: ignore[type-var]
    """
    Middleware to customize the system prompt for the agent.
    """

    def __init__(self, prompt_generator: SystemPromptGenerator):
        self.system_prompt_generator = prompt_generator

    @override
    def before_model(
        self, state: AgentState, runtime: Runtime[ContextT]
    ) -> dict[str, Any] | None:
        messages = state.get("messages", [])
        current_skill = state.get("current_skill")

        # find the last HumanMessage in the messages to use its content as the query for generating the RAG summary, if available
        if messages and isinstance(messages[-1], HumanMessage):
            query = messages[-1].content
        else:
            query = None

        new_system_message = self.system_prompt_generator.generate_system_prompt(
            current_skill,
            query,  # type: ignore[arg-type] # FIX ME
        )
        # replace or insert the system message at the beginning of the messages
        if (
            messages
            and isinstance(messages[0], BaseMessage)
            and messages[0].type == "system"
        ):
            messages[0] = new_system_message
        else:
            messages.insert(0, new_system_message)
        return {"messages": messages}


# -------------------------------------------------------------------------------
class OverlordAgent(AgentMiddleware[AgentState, None, None]):  # type: ignore[type-var]
    def __init__(
        self,
        workspace_path: Path,
        workspace_template_path: Path | None = None,
        configuration_path: Path | None = None,
        nickname: str | None = None,
        debug: bool = False,
    ):
        self.nickname = nickname or make_bot_name()
        self.configuration_path = configuration_path
        self.configuration = None
        self.workspace_path = workspace_path
        self.workspace_template_path = workspace_template_path
        self.debug = debug
        self.mcp_client = None
        self.graph: CompiledStateGraph | None = None  # type: ignore[type-arg] # FIX ME
        self.ralph_mode_manager = RalphMode()
        self.rag_source: RagIndex | None = None
        self.prompt_generator: SystemPromptGenerator | None = None

    async def _initialize_workspace(self):  # type: ignore[no-untyped-def] # FIX ME

        # Ensure that there is a agent directory
        self.agent_folder.mkdir(parents=True, exist_ok=True)

        # workspace template : if the workspace template is a directory, copy files that are not already present in the workspace
        if self.workspace_template_path:
            if (self.workspace_template_path / ".overlord").is_dir():
                for item in (self.workspace_template_path / ".overlord").iterdir():
                    dest = self.workspace_path / ".overlord" / item.name
                    if not dest.exists():
                        if item.is_dir():
                            logger.debug(f"Copying directory {item} to {dest}")
                            shutil.copytree(item, dest)
                        else:
                            logger.debug(f"Copying file {item} to {dest}")
                            shutil.copy(item, dest)

            # when the workspace template is an archive file (e.g., zip), extract it into the workspace if the workspace is empty
            elif self.workspace_template_path.is_file():
                for archive_path, file_data in extract_archive(
                    self.workspace_template_path
                ):
                    if re.match(r"^/?\.overlord/.*", archive_path):
                        dest = self.workspace_path / archive_path
                        if not dest.exists():
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            with open(dest, "wb") as f:
                                logger.debug(
                                    f"Extracting {archive_path} from archive to {dest}"
                                )
                                shutil.copyfileobj(file_data, f)

        # Then load the configuration file
        if self.configuration_path is None:
            self.configuration_path = self.workspace_path / ".overlord" / "config.yaml"
        logger.debug(f"Loading configuration from {self.configuration_path}")

        self.configuration = Configuration.from_yaml(self.configuration_path)  # type: ignore[assignment] # FIX ME

        # Agent avatar : if there is no .overlord/<nickname>/AVATAR.png file in the workspace, create it
        avatar_path = self.agent_folder / "AVATAR.png"
        if not avatar_path.exists():
            avatar_image = generate_avatar_image(self.nickname)
            avatar_path.parent.mkdir(parents=True, exist_ok=True)
            avatar_image.save(avatar_path)
            logger.debug(f"Generated avatar for {self.nickname} at {avatar_path}")

        # if there is a .overlord/RALPH.md file in the workspace, copy it into the agent's specific folder for ralph mode message
        if (self.workspace_path / ".overlord" / "RALPH.md").exists():
            shutil.copy(
                self.workspace_path / ".overlord" / "RALPH.md",
                self.agent_folder / "RALPH.md",
            )
            logger.debug(f"Copied RALPH.md to {self.agent_folder / 'RALPH.md'}")

        # if the workspace contains a ".overlord/<nickname>/RALPH.md" file, use it as the ralph mode message
        ralph_mode_message_path = self.agent_folder / "RALPH.md"
        if ralph_mode_message_path.exists():
            self.ralph_mode_manager.ralph_mode_message = (
                ralph_mode_message_path.read_text()
            )
            logger.debug(f"Loaded Ralph Mode message from {ralph_mode_message_path}")

        # if the workspace contains a "documentation" folder, initialize RAG source with it
        documentation_path = self.workspace_path / "documentation"
        if documentation_path.exists() and documentation_path.is_dir():
            try:
                self.rag_source = RagIndex(  # type: ignore[call-arg] # FIX ME
                    embedding_model=self.configuration.load_embedding_model(),  # type: ignore[attr-defined] # FIX ME
                    documents_path=documentation_path,
                    watch=True,
                )
            except Exception:
                logger.exception("RAG will be disabled")

        self.prompt_generator = SystemPromptGenerator(
            self.workspace_path, self.nickname, rag_source=self.rag_source
        )

    @property
    def agent_folder(self) -> Path:
        return self.workspace_path / ".overlord" / self.nickname

    def _get_available_skill_names(self) -> list[str]:
        return list(self.prompt_generator.skills.keys())  # type: ignore[union-attr] # FIX ME

    async def _configure_tools(self, state: AgentState) -> list[BaseTool]:
        # logic to configure the agent's tools, potentially based on the current state or other factors
        mcp_config = self.configuration.load_mcp_servers_config()  # type: ignore[attr-defined] # FIX ME

        # if there is not 'filesytem' mcp server, we add our own
        # if "filesystem" not in mcp_config:
        #     mcp_config["filesystem"] = {
        #         "transport": "stdio",
        #         "command": "npx",
        #         "args": [
        #             "@modelcontextprotocol/server-filesystem",
        #             self.workspace_path.as_posix(),
        #         ],
        #     }

        self.mcp_client = MultiServerMCPClient(mcp_config, tool_name_prefix=True)  # type: ignore[assignment]

        tools: list[BaseTool] = await self.mcp_client.get_tools()  # type: ignore[attr-defined]

        # also add our custom tool for running commands
        #tools.append(RunCmdTool(workspace_path=self.workspace_path))

        # add the tool that allows activating skills
        # this special tool for activating skills.
        @tool
        def activate_skill(skill_id: str):  # type: ignore[no-untyped-def]
            """Use this tool to activate a skill by providing its SKILL_ID."""
            skill_names = self._get_available_skill_names()
            if skill_id not in skill_names:
                logger.warning(
                    f"Agent attempted to activate invalid skill_id '{skill_id}'. Available skills: {skill_names}"
                )
                return "Error: Invalid skill_id. Available skills are: " + ", ".join(
                    skill_names
                )
            state.next_skill = skill_id
            definition = self.prompt_generator.skills.get(skill_id)  # type: ignore[union-attr] # FIX ME
            return definition.content  # type: ignore[union-attr] # FIX ME

        tools += [activate_skill]

        ## Tool that write to MEMORY.md
        @tool
        def write_to_memory(content: str):  # type: ignore[no-untyped-def]
            """Save an important fact or remark in MEMORY.md"""
            memory_file = self.agent_folder / "MEMORY.md"
            sanitized = re.sub(r"\s+", " ", content.strip())
            formatted_content = f"- [{datetime.datetime.now(tz=datetime.timezone.utc).isoformat(timespec='seconds')}] {sanitized}"
            with open(memory_file, "a") as f:
                f.write(formatted_content + "\n")
            return f"Written to memory: {content}"

        tools += [write_to_memory]

        if self.debug:
            logger.debug(
                f"Configured tools: \n- {'\n- '.join([tool.name for tool in tools])}"
            )

        return tools

    @override
    def before_model(
        self, state: AgentState, runtime: Runtime[None]
    ) -> dict[str, Any] | None:
        messages = state.get("messages", [])
        current_skill = state.get("current_skill")
        next_skill = state.get("next_skill")
        if next_skill and next_skill != current_skill:
            logger.debug(f"Activating skill: {next_skill}")
            state.set("current_skill", next_skill)
            state.set("next_skill", None)
            messages.append(
                SystemMessage(
                    content=self.prompt_generator.skills[state.get("current_skill")].content  # type: ignore[union-attr] # FIX ME
                )
            )  # type: ignore  # FIX ME # FIX ME
            return {"messages": messages}
        else:
            return None

    async def _initialize_graph(self):  # type: ignore[no-untyped-def]

        # Load model
        model = self.configuration.load_model()  # type: ignore[attr-defined] # FIX ME
        logger.debug(f"Loaded model: {model}")

        # create initial state
        state = AgentState(
            debug=self.debug, workspace_path=self.workspace_path, nickname=self.nickname
        )

        # configure tools
        tools = await self._configure_tools(state)

        # bind middleware, including custom prompt middleware, retry logic, and conversation shrinking
        middleware = [
            self,
            CustomPromptMiddleware(self.prompt_generator),  # type: ignore[arg-type] # FIX ME
            ModelRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=3.0),
            ConversationShrinkerMiddleware(),
            SummarizationMiddleware(model=model, keep=("messages", 20)),
        ]

        # create a deepagent using the configuration.
        agent = create_deep_agent(
            model=model,
            tools=tools,
            backend=FilesystemBackend(root_dir = self.workspace_path, virtual_mode=True),
            middleware=middleware,
            debug=self.debug,
            name=self.nickname,
        )

        # modify the graph of the agent so it can go into "ralph mode"
        self.graph = self.ralph_mode_manager.wrap_agent(agent)

        # dump the agent's guts for debugging
        if self.debug:
            try:
                logger.debug(self.graph.get_graph(xray=True).draw_ascii())
                #logger.debug(self.graph.get_graph(xray=True).draw_mermaid())
                #(self.agent_folder / "graph.png").write_bytes(
                #    self.graph.get_graph(xray=True).draw_mermaid_png()
                #)
            except Exception:
                pass

    async def arun(self, task: str):  # type: ignore[no-untyped-def]

        if not self.graph:
            await self._initialize_workspace()  # type: ignore[no-untyped-call] # FIX ME
            await self._initialize_graph()  # type: ignore[no-untyped-call] # FIX ME

        async for channel, item in self.graph.astream(  # type: ignore[union-attr] # FIX ME
            {"messages": [HumanMessage(content=task)]},
            stream_mode=["messages", "custom"],
        ):  # type: ignore # FIX ME # FIX ME
            if channel == "messages":
                msg = item[0]
                if isinstance(msg, AIMessage):
                    print(msg.content)
            else:
                logger.debug(f"{item}")  # type: ignore # FIX ME # FIX ME

        ##return await agent.ainvoke({"messages": [HumanMessage(content=task)]})  # type: ignore[name-defined]