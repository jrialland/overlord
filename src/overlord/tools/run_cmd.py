"""
This implements a tool for running shell commands.
Notice: contrary to the similar tool that comes with the deepagents library, this tool has NO SANDBOXING whatsoever,
so use it at your risk !
"""

import asyncio
import os
import time
from pathlib import Path

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, field_validator


def _combine_output(stdout: str, stderr: str) -> str:
    if stdout and stderr:
        return f"{stdout}\n{stderr}"
    return stdout or stderr


class RunCmdResult(BaseModel):
    stdout: str = Field(description="Standard output from the command")
    stderr: str = Field(description="Standard error output from the command")
    combined_output: str = Field(description="Combined stdout and stderr")
    exit_code: int = Field(description="Exit code of the command")
    ok: bool = Field(
        description="Whether the command executed successfully (exit code 0)"
    )
    timed_out: bool = Field(description="Whether the command execution timed out")
    duration_ms: int = Field(
        description="Duration of command execution in milliseconds"
    )
    command: str = Field(description="The command that was executed")


async def run_cmd_impl(
    cmd: str,
    cwd: str | None = None,
    timeout_seconds: int | None = None,
    merge_streams: bool = False,
    interpreter: str | None = None,
) -> RunCmdResult:
    """
    Internal implementation of the shell command execution. This function is meant to be run in an asynchronous context.
    """
    started = time.perf_counter()
    process = await asyncio.create_subprocess_shell(
        executable=interpreter,
        cmd=cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        shell=True,  # nosec
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=timeout_seconds
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        return RunCmdResult(
            stdout="",
            stderr="",
            ok=False,
            exit_code=-1,
            combined_output=f"Command timed out after {timeout_seconds} seconds.",
            timed_out=True,
            duration_ms=int((time.perf_counter() - started) * 1000),
            command=cmd,
        )

    def decode_bytes(data: bytes, known_encoding: str | None = None) -> tuple[str, str]:
        """Decode bytes trying multiple encodings for cross-platform compatibility."""
        if not data:
            return "", known_encoding or "utf-8"
        if known_encoding:
            try:
                return data.decode(known_encoding).strip(), known_encoding
            except UnicodeDecodeError:
                pass  # fall back to trying other encodings
        # Try encodings in order of likelihood
        for encoding in [
            "utf-8",
            "utf-8-sig",
            "cp1252",
            "iso-8859-1",
            "cp850",
            "cp437",
        ]:
            try:
                return data.decode(encoding).strip(), encoding
            except UnicodeDecodeError:
                continue
        # Final fallback: decode with utf-8 and replace invalid chars
        return data.decode("utf-8", errors="replace").strip(), "utf-8"

    stdout_text, encoding = decode_bytes(stdout)
    stderr_text, _ = decode_bytes(stderr, known_encoding=encoding)
    if merge_streams:
        stdout_text = _combine_output(stdout_text, stderr_text)
        stderr_text = ""

    combined = _combine_output(stdout_text, stderr_text)
    exit_code = int(process.returncode or 0)

    return RunCmdResult(
        ok=exit_code == 0,
        exit_code=exit_code,
        stdout=stdout_text,
        stderr=stderr_text,
        combined_output=combined,
        timed_out=False,
        duration_ms=int((time.perf_counter() - started) * 1000),
        command=cmd,
    )


class RunCmdToolArgsSchema(BaseModel):
    cmd: str = Field(description="The shell command to execute")
    cwd: str | None = Field(
        default=None,
        description="The working directory in which to execute the command. The current workspace directory will be used.",
    )
    timeout_seconds: int | None = Field(
        default=None,
        description="Maximum time in seconds to allow for command execution before timing out. If not provided, there is no timeout.",
    )
    merge_streams: bool = Field(
        default=False,
        description="Whether to merge stdout and stderr into a single output stream. If true, stderr will be included in the stdout field of the result, and the stderr field will be empty.",
    )


class RunCmdTool(StructuredTool):
    workspace_path: Path = Field(
        description="The path to the workspace directory, used as the default working directory for command execution"
    )
    interpreter: str = Field(
        ...,
        description="The command interpreter to use (e.g. '/bin/bash -c' or 'cmd.exe /c')",
    )

    def __init__(self, **kwargs):  # type: ignore[no-untyped-def] # FIX ME

        if os.name == "nt":
            self.description, self.interpreter = (
                "Execute a Windows command using cmd.exe. Do not assume shell syntax or features that are not supported by Windows cmd.",
                "cmd.exe /c",
            )
        else:
            self.description, self.interpreter = (
                "Execute a shell command using bash. You can use typical shell syntax and features.",
                "/bin/bash -c",
            )

        super().__init__(
            name="run_cmd",
            description=self.description,
            args_schema=RunCmdToolArgsSchema,
            coroutine=self._run_cmd_impl_wrapper,
            **kwargs,
        )

    @field_validator("workspace_path", mode="after")
    @classmethod
    def validate_workspace_path(cls, workspace_path: Path) -> Path:
        if not workspace_path.is_dir():
            raise ValueError(
                f"Invalid workspace path: {workspace_path} is not a directory"
            )
        return workspace_path

    async def _run_cmd_impl_wrapper(
        self,
        cmd: str,
        cwd: str | None = None,
        timeout_seconds: int | None = None,
        merge_streams: bool = False,
    ) -> RunCmdResult:
        cwd = cwd or str(self.workspace_path)
        return await run_cmd_impl(
            cmd=cmd,
            cwd=cwd,
            timeout_seconds=timeout_seconds,
            merge_streams=merge_streams,
            interpreter=self.interpreter,
        )