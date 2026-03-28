"""
Ralph mode (aka forced continuation) :
Modifiy the graph of an agent in order to force the agent to continue the conversation :
the graph is modified to add a conditional loop that checks for a "ralph_mode_enabled" flag in the state, and if it's set to True, it loops back to a "ralph_mode_start" node that can be used as a starting point for the agent to continue the conversation without needing user input.
This allows the agent to keep going and generate more content, even if the user doesn't provide new input.

The state shall have :
- "ralph_mode_enabled" : a boolean flag that indicates whether Ralph Mode is enabled or not.
- "ralph_mode_counter" : an integer counter that keeps track of how many times the agent has looped in Ralph Mode

"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware.types import AgentState
from langchain_core.messages import SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph  # type: ignore # FIX ME # FIX ME
from loguru import logger


class RalphMode:
    """Middleware to enable Ralph Mode features in the agent."""

    def __init__(self, ralph_mode_message: str | None = None):
        self.ralph_mode_message = (
            ralph_mode_message or "Continue to perform the task that you are doing"
        )

    def _condition_is_ralph_mode_enabled(self, state: AgentState[Any]) -> str:
        ralph_mode_enabled = state.get("ralph_mode_enabled", False)
        return "ralph_mode_enabled" if ralph_mode_enabled else "ralph_mode_disabled"

    def _step_ralph_mode_begin(self, state: AgentState[Any]) -> AgentState[Any]:
        # initialize the counter if not present
        if "ralph_mode_counter" not in state:
            state["ralph_mode_counter"] = 0  # type: ignore[typeddict-unknown-key] # FIX ME
            # dont do anything at the first iteration
        else:
            if state["ralph_mode_enabled"]:  # type: ignore[typeddict-item] # FIX ME
                state["ralph_mode_counter"] += 1  # type: ignore[typeddict-item] # FIX ME
                # if enabled, inject a SystemMessage that tells the agent to continue
                messages = state.get("messages", [])
                messages.append(SystemMessage(content=self.ralph_mode_message))
                logger.info(
                    "Ralph mode : added system message to current conversation"
                )
        if state.get("ralph_mode_enabled", False):
            state["messages"].append(SystemMessage(content=self.ralph_mode_message))
        return state

    def _make_graph(self, wrapped_graph: CompiledStateGraph) -> StateGraph:  # type: ignore[type-arg] # FIX ME
        builder = StateGraph(dict)  # type: ignore[type-var] # FIX ME
        builder.add_node("ralph_mode_begin", self._step_ralph_mode_begin)
        builder.add_node("ralph_mode_wrapped_graph", wrapped_graph)
        builder.add_node("ralph_mode_end", lambda state: state)  # no-op step

        builder.add_edge(START, "ralph_mode_begin")
        builder.add_edge("ralph_mode_begin", "ralph_mode_wrapped_graph")
        builder.add_edge("ralph_mode_wrapped_graph", "ralph_mode_end")

        builder.add_conditional_edges(
            "ralph_mode_end",
            self._condition_is_ralph_mode_enabled,
            {
                "ralph_mode_enabled": "ralph_mode_begin",
                "ralph_mode_disabled": END,
            },
        )
        return builder
    
    
    def wrap_agent(self, agent: CompiledStateGraph) -> CompiledStateGraph:  # type: ignore[type-arg] # FIX ME
        """Wrap the agent's graph with Ralph Mode logic."""
        new_graph = self._make_graph(agent)
        return new_graph.compile()