# TODOS and ideas

## BUG 1 

I have started a CLi session with both --query and --interactive, and it seems that the first user message is lost in the conversation, the agent cannot recall it.

gemma4:26b seems to be really stupid :

(user) "Please read https://raw.githubusercontent.com/jmilinovich/goal-md/refs/heads/main/GOAL.md as an example on how to create a similar GOAL.md adapted to the current project"
(agent) 🛠️ FetchWebContent({"url":"https://raw.githubusercontent.com/jmilinovich/goal-md/refs/heads/main/GOAL.md"})
(agent reasoning) The user wants to create a simple web application that shows a "Hello World" message.
The app should use the AI SDK for a basic AI-powered feature, like a greeting that changes based on a prompt.
I'll use React and the AI SDK.
I'll use Bulma CSS for styling.


## BUG 2

Plan mode: Agents report that they cannot "see" the *Todo* tools when they are in plan mode !

```markdown
... The plan mode description mentions using "*Todo*" tools, but **no Todo tools are currently available** in my tool set. This means:

1. I cannot create structured todo/task lists
2. I cannot track task status incrementally
```

It seems that the list of tools is not updated when we switch mode, most probably because the way we are running in the react loop
prevent use to change the tools during a turn.

Maybe we would have to split the react graph into finer-grained graph nodes in order to be able to change things more often, like langchain does.

## BUG 3

dependencies from package.json include tiktoken and gpt-tokenizer
The two libraries so almost the same thing !! refactor the code in order to keep the better one (better = most popular most recent with better support)

## Get rid of bus module

Evaluate the switch to rxjs

=> Simplify event-base communication means across the project; use a single way to emit/consume events

## persistence :

The whole persistence thing is not used at all, we shall get rid of all the persistence module alltogether, and reimplement persistence in dedicated AgentPlugin later

## subAgents

the GetSubAgentStatus only shows the lifecycle status. It should also show the final outcome for the parent agent to consume.

For now, GetSubAgentStatus is called repeatibly by the parent agent until subagent terminates : in wastes tokens in the context of the parent agent.

we shall have a more clever mechanism (wait for status changes using signals,  with timeout) -> That would decrease the amount of tool calls :
GetSubAgentStatus => WaitForSubAgent that waits up to 30s for a subagent to change state.

GetSubAgentStatus would disappear, replaced by extended informations in ListSubAgents

## memory

    Implement Memory.md scratchpad using a specific tool WriteToMemory

    Implement a structured knowledge base like Obsidian or Notion ?

## dream mode

beside plan and agent, a third mode with a specific prompt asking to the agent to reorganize its memory

## worktrees

    A tool that allow to create git worktrees ; subagents may spawn a worktree (add a parameter to CreateSubAgent)

    
## GOAL.md

    A specialized way to achieve a plan : The agent has to measure fitness (using a special script that gives a score) and is asked to improve the score repeatively, until 100% is achieved (https://github.com/jmilinovich/goal-md) to be implemented as a plugin

## mechanism for loading external plugins

## improve CLI ?

## summarization follow-ups

    improve summary quality controls and expose forced summarization commands more directly in interactive flows

## Daemon mode, Web UI

there shall be a --daemon mode that only exposes the API for passing commands, get events and manage agents. A Web UI could then connect to it.