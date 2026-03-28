"""Test configuration and shared fixtures."""

import os
from pathlib import Path

import pytest
from dotenv import load_dotenv


@pytest.fixture(scope="session", autouse=True)
def env():
    """Load environment variables from .env file before any tests run."""
    load_dotenv()
    return os.environ

@pytest.fixture(scope="session")
def base_path():
    return (Path(__file__).parent / "..").absolute().resolve()

@pytest.fixture(scope="session")
def workspace_template_path(base_path: Path) -> Path:
    return base_path / "workspace-template"

@pytest.fixture(scope="session")
def conf_path(workspace_template_path: Path) -> Path:
    return workspace_template_path / ".overlord/config.yaml"


@pytest.fixture(scope="session")
def workspace_path(base_path: Path) -> Path:
    return (base_path / "test_workspace").absolute().resolve()