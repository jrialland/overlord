from pathlib import Path

import pytest

from overlord.agent import OverlordAgent


def test_overlord_agent_creation(conf_path: Path, workspace_path: Path):
    agent = OverlordAgent(
        configuration_path=conf_path, workspace_path=workspace_path, debug=True
    )
    assert agent is not None


@pytest.mark.asyncio
async def test_overlord_agent_initialize_graph(conf_path: Path, workspace_path: Path):
    agent = OverlordAgent(
        workspace_path=workspace_path, configuration_path=conf_path, debug=True
    )
    await agent._initialize_workspace()
    await agent._initialize_graph()
