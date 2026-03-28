"""
CLI entry point for Overlord agent. This module defines the command-line interface for interacting with the Overlord agent, allowing users to execute commands, manage workspaces, and configure settings directly from the terminal.
"""
import asyncio
import sys
from pathlib import Path

import click
import dotenv

from overlord.agent import OverlordAgent

dotenv.load_dotenv()  # Load environment variables from .env file if it exists

@click.command()
@click.option('--workspace', '-w', required=True, help='Path to the workspace directory.')
@click.option('--workspace-template', '-t', required=False, help='Optional path to a workspace template directory or archive to initialize from.')
@click.option('--config', '-c', required=False, help='Optional path to a configuration file (defaults to <workspace>/.overlord/config.yaml if not provided).')
@click.option('--nickname', '-n', required=False, help='Nickname for the agent. If not provided, a new agent will be created with a random nickname.')
@click.option('--query', '-q', required=False, help='Initial query or task for the agent to execute upon startup. Reads from input() if missing.')
@click.option('--debug', is_flag=True, help='Enable debug mode.')
def run_agent(  # type: ignore[no-untyped-def] # FIX ME
    workspace: str,
    workspace_template: str | None = None,
    config: str | None = None,
    nickname: str | None = None,
    query: str | None = None,
    debug: bool = False
):
    """
    CLI command to run an Overlord agent.
    """
    click.echo(f"Starting Overlord agent with workspace: {workspace}")
    if workspace_template:
        # verify that the workspace template path exists is specified and is a directory
        template_path = Path(workspace_template)
        if not template_path.exists():
            click.echo(f"Error: Workspace template '{workspace_template}' does not exist.", err=True)
            sys.exit(1)
        click.echo(f"Using workspace template: {workspace_template}")
    
    if config:
        click.echo(f"Using configuration file: {config}")
    
    if nickname:
        click.echo(f"Agent nickname: {nickname}")
    
    # If query is not provided, read from standard input
    if query is None:
        # wait for query from stdin
        query = input()

    agent = OverlordAgent(
        workspace_path=Path(workspace),
        workspace_template_path=Path(workspace_template) if workspace_template else None,
        configuration_path=Path(config) if config else None,
        nickname=nickname,
        debug=debug
    )

    event_loop = asyncio.get_event_loop()
    try:
        event_loop.run_until_complete(agent.arun(query))
    except KeyboardInterrupt:
        pass
    finally:
       event_loop.close()
    
if __name__ == "__main__":
    run_agent()