# TODOS and ideas

## memory

    Implement Memory.md scratchpad using a specific tool

## worktrees

    A tool that allow to create git worktrees ; subagents may spawn a worktree.
    Persistence shall be moved from sqlite data to a system that handles forking/merging better.

## GOAL.md

    A specialized way to achieve a plan : The agent has to measure fitness (using a special script that gives a score) and is asked to improve the score repeatively, until 100% is achieved (https://github.com/jmilinovich/goal-md) to be implemented as a plugin

## mechanism for loading external plugins

## improve CLI ?

## summarization follow-ups

    improve summary quality controls and expose forced summarization commands more directly in interactive flows

## Daemon mode, Web UI

there shall be a --daemon mode that only exposes the API for passing commands, get events and manage agents. A Web UI could then connect to it.