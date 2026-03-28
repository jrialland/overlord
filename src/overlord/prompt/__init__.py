"""
This module generates the system prompt for the agent
"""

from __future__ import annotations

from datetime import datetime
import getpass
import os
import platform
from pathlib import Path
import time
import jinja2
from langchain.messages import SystemMessage
from loguru import logger

from overlord.rag import RagIndex

from .skills import SkillDefinition, skills_descriptions_to_markdown


class SystemPromptGenerator:

    SECTIONS = [
        "IDENTITY.md",  # Agent's identity
        "SOUL.md",  # Core values and principles guiding the agent's behaviour.
        "AGENTS.md",  # General agent rules. (see https://agents.md/ )
        "USER.md",
        "<skills-summary>",  # Dynamically generated summary of available skills, inserted at prompt time.
        "<rag-summary>",  # Dynamically generated summary of RAG sources, inserted at prompt time.
        "<memory-summary>",  # Agent's own memory
    ]

    def __init__(self,
        workspace_path: Path,
        agent_nickname:str,
        jinja_variables: dict[str, str] | None = None,
        rag_source: RagIndex | None = None,
        max_memory_lines: int = 20,
        ):
        assert workspace_path.is_dir(), f"Workspace path {workspace_path} is not a directory"
        assert agent_nickname, "Agent nickname must be provided"
        self.workspace_path = workspace_path
        self.agent_nickname = agent_nickname
        self.max_memory_lines = max_memory_lines
        self._jinja_variables = jinja_variables or {}
        self.skills: dict[str, SkillDefinition] = self._load_skills(workspace_path)
        self.rag_source = rag_source
        self._initialize_variables()  # type: ignore[no-untyped-call] # FIX ME

    def _initialize_variables(self):  # type: ignore[no-untyped-def] # FIX ME

        # add current workspace path
        self._jinja_variables["workspace_path"] = self.workspace_path.absolute().as_posix()

        # add agent name
        self._jinja_variables["nickname"] = self.agent_nickname

        # add current operating system
        uname_result = platform.uname()
        self._jinja_variables["uname"] = f"{uname_result.system} {uname_result.release} ({uname_result.version})"

        # add current user name
        user = 'anonymous'
        try:
            user = getpass.getuser()
        except Exception:
            logger.exception("Failed to get current user name")
        self._jinja_variables["whoami"] = user
        
        # add environment variables
        self._jinja_variables["env"] = os.environ  # type: ignore[assignment] # FIX ME

        # date and time variables
        now = datetime.now()
        self._jinja_variables["current_time"] = now.strftime("%H:%M:%S")
        self._jinja_variables["current_date"] = now.strftime("%A, %B %d, %Y")
        self._jinja_variables["current_timezone"] = now.astimezone().tzname() + f" (UTC{now.astimezone().strftime('%z')})"

        # add agent avatar path
        avatar_path = self.workspace_path / ".overlord" / self.agent_nickname / "AVATAR.png"
        if avatar_path.exists():
            self._jinja_variables["avatar_path"] = avatar_path.relative_to(self.workspace_path).as_posix()
        logger.debug(f"Initialized Jinja variables: {self._jinja_variables}")

    @property
    def jinja_variables(self) -> dict[str, str]:
        return self._jinja_variables

    @staticmethod
    def _load_skills(base_path: Path) -> dict[str, SkillDefinition]:
        """
        Load skills from the workspace. Skills are expected to be defined in SKILL.md files under the "skills" directory.
        """
        skills: dict[str, SkillDefinition] = {}
        for subdir in (".overlord/skills", ".claude/skills", ".agents/skills"):
            for skill_file in (base_path / subdir).rglob("**/SKILL.md"):
                try:
                    skill_def = SkillDefinition.load_from_file(skill_file)
                    if skill_def is not None:
                        if skill_def.name in skills:
                            logger.warning(
                                f"Duplicate skill name '{skill_def.name}' found in {skill_file} and {skills[skill_def.name].location}. Skipping {skill_file}."
                            )
                        else:
                            skills[skill_def.name] = skill_def
                except Exception as e:
                    logger.warning(f"Failed to load skill from {skill_file}: {e}")
        return skills

    def generate_system_prompt(self, current_skill_name: str | None, query: str | None = None) -> SystemMessage:
        """
        Generate the system prompt for the agent, including the list of available skills.
        """
        sections: list[str] = []
        for section in self.SECTIONS:
            if section == "<skills-summary>":
                sections.append(
                    skills_descriptions_to_markdown(
                        self.skills, self.workspace_path, current_skill_name
                    )
                )
                logger.debug("Added skills summary to system prompt")
            elif section == "<rag-summary>" and query and self.rag_source is not None:
                sections.append("# Relevant workspace files\n\n" + self.rag_source.generate_summary("system prompt RAG summary"))
                logger.debug("Added RAG summary to system prompt")
            elif section == "<memory-summary>":
                # fetch the last n lines from the agent's memory and include them in the prompt. For now we just include a placeholder since memory is not implemented yet.
                memory_md = self.workspace_path / ".overlord" / self.agent_nickname / "MEMORY.md"
                if memory_md.exists():
                    with open(memory_md, "r", encoding="utf-8") as f:
                        memory_content = f.readlines()[-self.max_memory_lines:]  # get the last n lines of memory
                        # skip the lines that do not start with '- ' since they are not actual memory entries but rather system messages or other non-memory content
                        memory_content = [line for line in memory_content if line.startswith("- ")]
                        if memory_content:
                            sections.append("# Recent entries for MEMORY.md\n\n" + "\n".join(memory_content))
                            logger.debug("Added memory summary to system prompt")
            elif section == 'AGENTS.md':
                # load AGENTS.md directly from the workspace folder with no templating
                section_path = self.workspace_path / "AGENTS.md"
                if section_path.exists():
                    section_data = section_path.read_text(encoding="utf-8")
                    sections.append(section_data)
                    logger.debug(f"Loaded {section_path.name} without templating")
            else:
                # agent's "personal" folder takes precedence over the generic one, allowing for agent-specific overrides
                section_path = self.workspace_path / ".overlord" / self.agent_nickname / section
                if not section_path.exists():
                    section_path = self.workspace_path / ".overlord" / section

                if section_path.exists():
                    section_data = section_path.read_text(encoding="utf-8")
                    template = jinja2.Template(section_data)
                    rendered_section = template.render(**self.jinja_variables)
                    sections.append(rendered_section)
                    logger.debug(f"Loaded {section_path.name}")
                else:
                    logger.warning(f"Section {section_path} not found.")

        prompt_content = "\n\n---\n".join(sections)
        return SystemMessage(content=prompt_content)