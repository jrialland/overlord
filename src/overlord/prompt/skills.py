from __future__ import annotations

import re
from pathlib import Path
from typing import Any, cast
import yaml  # type: ignore[import-untyped] # FIX ME
from loguru import logger
from markdown_strings import (  # type: ignore[import-untyped] # FIX ME
    table_delimiter_row,
    table_row,
)

# skill name : Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen. 64 chars max.
_SKILL_NAME_REGEX = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


def load_markdown_with_frontmatter(md_path: Path) -> tuple[dict[str, Any] | None, str]:
    """Load a Markdown file and parse its YAML frontmatter.
    If the file does not contain valid frontmatter, returns (None, full_content).
    Args:
        md_path: Path to the Markdown file.
    Returns:
        A tuple of (frontmatter_dict or None, markdown_content_without_frontmatter)
    """
    content = md_path.read_text(encoding="utf-8")
    match = _FRONTMATTER_RE.match(content)

    if not match:
        return None, content

    fm_raw, md = match.groups()
    try:
        frontmatter = yaml.safe_load(fm_raw)
    except yaml.YAMLError:
        logger.warning(f"Skill file {md_path} has invalid YAML frontmatter, skipping.")
        return None, ""

    if frontmatter is None:
        logger.warning(f"Skill file {md_path} has empty frontmatter, skipping.")
        return None, ""

    if not isinstance(frontmatter, dict):
        logger.warning(f"Skill file {md_path} frontmatter is not a mapping, skipping.")
        return None, ""

    return cast(dict[str, Any], frontmatter), md.strip()


class SkillDefinition:
    """
    Represents one validated skill parsed from a SKILL.md file.
    """

    def __init__(
        self,
        location: Path,
        name: str,
        description: str,
        content: str,
        license: str | None = None,
        compatibility: str | None = None,
        metadata: dict[str, str] | None = None,
        allowed_tools: list[str] | None = None,
    ):
        """
        Args:
            location: path to the SKILL.md file.
            name: Skill name. It should be unique among loaded skills.
            description: Skill description used by the agent for selection.
            license: Optional license information for compliance/attribution.
            compatibility: Optional environment requirements information.
            metadata: Optional key-value metadata map.
            allowed_tools: Optional list of pre-approved tools.
            jinja_variables: Optional dictionary of Jinja template variables.
        """
        self.location = location
        self.name = name
        self.description = description
        self.content = content
        self.license = license
        self.compatibility = compatibility
        self.metadata = metadata
        self.allowed_tools = allowed_tools

    @staticmethod
    def load_from_file(skill_file: Path) -> SkillDefinition | None:
        """
        Load and validate a single skill from a SKILL.md file.

        Returns ``None`` when the file is invalid.
        """
        if skill_file.name != "SKILL.md":
            logger.warning(
                f"Skill file {skill_file} does not have the expected name 'SKILL.md', skipping."
            )
            return None

        frontmatter, content = load_markdown_with_frontmatter(skill_file)
        if frontmatter is None:
            logger.warning(
                f"Skill file {skill_file} does not contain frontmatter, skipping."
            )
            return None

        name = frontmatter.get("name")

        # Validate name.
        if name is None:
            logger.warning(
                f"Skill file {skill_file} does not declare a name in its frontmatter, skipping."
            )
            return None
        if not isinstance(name, str):
            logger.warning(f"Skill file {skill_file} has a non-string name, skipping.")
            return None
        if len(name) > 64:
            logger.warning(
                f"Skill file {skill_file} has a name longer than 64 chars, skipping."
            )
            return None
        if not _SKILL_NAME_REGEX.match(name):
            logger.warning(
                f"Skill file {skill_file} has an invalid name '{name}', skipping."
            )
            return None

        description = str(frontmatter.get("description", ""))
        # Validate description: non-empty, max 1024 characters.
        if not description.strip():
            logger.warning(
                f"Skill file {skill_file} does not declare a description in its frontmatter, skipping."
            )
            return None
        if len(description) > 1024:
            logger.warning(
                f"Skill file {skill_file} has a description longer than 1024 chars."
            )
            description = (
                description[:1022] + " …"
            )  # Truncate for safety, but still load the skill.

        license = frontmatter.get("license")
        compatibility = frontmatter.get("compatibility")
        # If compatibility is present, max length is 500 characters.
        if compatibility and len(compatibility) > 500:
            logger.warning(
                f"Skill file {skill_file} has a compatibility declaration longer than 500 chars."
            )
            compatibility = (
                compatibility[:498] + " …"
            )  # Truncate for safety, but still load the skill.

        metadata = frontmatter.get("metadata")

        # Metadata must be a dict when present.
        if metadata and not isinstance(metadata, dict):
            logger.warning(
                f"Skill file {skill_file} has a metadata field that is not a dict, skipping."
            )
            return None

        allowed_tools = frontmatter.get("allowed-tools")
        if allowed_tools is not None:
            if isinstance(allowed_tools, str):
                allowed_tools = (
                    allowed_tools.split()
                )  # Also accept a space-delimited string.
            if not isinstance(allowed_tools, list) or not all(
                isinstance(t, str) for t in allowed_tools
            ):
                logger.warning(
                    f"Skill file {skill_file} has an allowed-tools field that is not a list of strings, skipping."
                )
                return None

        skill_def = SkillDefinition(
            location=skill_file,
            name=name,
            description=description,
            content=content,
            license=license,
            compatibility=compatibility,
            metadata=metadata,
            allowed_tools=allowed_tools,
        )

        return skill_def


def skills_descriptions_to_markdown(
    skills: dict[str, SkillDefinition],
    workspace_path: Path,
    current_skill_name: str | None,
    activate_tool_name: str | None,
) -> str:
    """
    Convert skill definitions to a Markdown table for prompt-time selection.
    """
    activate_tool_name = activate_tool_name or "activate_skill"
    md = "# Available skills\n\n"
    plural, _is = ("", "is") if len(skills) == 1 else ("s", "are")
    md += f"_SKILLS are task-specific capabilities that you can activate. There {_is} currently {len(skills)} available skill{plural}._\n\n"
    md += f"The following skills extend your capabilities. You can use a skill by invoking the `{activate_tool_name}` tool with the corresponding SKILL_ID.\n"
    md += "Activate a skill when its description matches the user's task or would materially improve execution..\n\n"
    md += table_row(["SKILL_ID", "Description"]) + "\n"
    md += table_delimiter_row(2) + "\n"

    for skill in skills.values():
        md += (
            table_row(
                [
                    f"{skill.name}{' (current)' if skill.name == current_skill_name else ''}",
                    skill.description.replace("\n", " "),
                ]
            )
            + "\n"
        )

    md += "\n"
    return md  # type: ignore[no-any-return] # FIX ME
