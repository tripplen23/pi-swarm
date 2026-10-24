# pi-swarm

<p align="center">
  <img src="assets/hero.png" alt="pi-swarm — async interactive subagents for pi" width="100%">
</p>

Async, interactive subagents for Pi, running in **Herdr** panes.

`subagent()` returns immediately. The sub-agent runs in its own Herdr pane
(split right off the parent pane, `--no-focus`, so pane creation never steals
keyboard focus). A live widget above the input tracks every running sub-agent,
and when one finishes, its result is steered into the main session as a
notification that triggers a new turn. Fully non-blocking.

```
╭─ Subagents ──────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m     │
│ 00:45  worker     waiting 2m           │
╰────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back
independently as each finishes.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated Herdr pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

## Bundled agents

| Agent | Model | Tools | Role |
|-------|-------|-------|------|
| **scout** | `opencode-go/deepseek-v4-flash` | read, grep, find, ls | Fast read-only recon |
| **researcher** | `opencode-go/deepseek-v4.1-flash` | web_search, web_fetch, safe_bash, codemode, mcp__firecrawl__* | Web research → sourced brief |
| **worker** | `opencode-go/deepseek-v4.1-flash` | read, write, edit, bash, web_search, web_fetch (+ spawns scout/researcher/qa) | Implementer |
| **reviewer** | `opencode-go/muse-spark-1.3-contributor` | read, grep, find, ls, safe_bash | Read-only code review |
| **qa** | `opencode-go/deepseek-v4.1-flash` | read, grep, find, ls, safe_bash, codemode, mcp__playwright_chrome__*, mcp__playwright_webkit__* | Web-app QA via Playwright MCP |

Model rationale:

- **scout** — mechanical locate-and-report. `deepseek-v4-flash` is the cheapest,
  fastest model with a 1M window; matches the low-thinking recon job.
- **researcher / worker** — agentic, multi-step, long outputs. `deepseek-v4.1-flash`
  has a 384K output budget and strong tool use.
- **reviewer** — read-only, bounded output. `muse-spark-1.3-contributor` is an
  affordable 1M-context model; review is a good fit for a cheaper tier.

Override per spawn with `subagent({ agent, model })`, or edit the frontmatter.

### MCP in subagents

Subagents are sandboxed with `--no-extensions`, so MCP is **off by default**. An
agent opts in by listing `codemode` plus MCP tools in its `tools` frontmatter
(`mcp__<server>__*` patterns or explicit names). The extension then launches the
child with `-e builtin:codemode -e builtin:mcp`, and the agent reaches the
servers through `codemode` scripts.

Using `codemode` is deliberate for token efficiency: only the script's output
enters the agent's context, so large browser accessibility snapshots never pile
up in it. See `agents/qa.md` for the pattern.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global).
Discovery priority: project > global > package-bundled.

```markdown
---
name: my-agent
description: Does something specific
model: opencode-go/deepseek-v4.1-flash
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

Key frontmatter fields: `model`, `thinking`, `tools` (strict allowlist),
`subagent_agents` (which agents this one may spawn; presence grants the spawning
tools), `skills`, `session-mode` (`standalone` | `lineage-only` | `fork`),
`system-prompt` (`append` | `replace`), `auto-exit`, `cwd`.

## Identifying agents

Every spawned pane is **renamed to the subagent's display name**, so the Herdr
tab bar / sidebar shows `scout`, `scout-2`, `worker`, …. The status widget above
the input lists names too. From the CLI: `herdr pane list`, `herdr agent list`,
`herdr agent get <name>`, `herdr agent read <name>`.

## Command calls

Sometimes a subagent should not be an agent at all: run the test suite, the
build, the long `sleep`. A command call runs a process in its own pane with no
model and no session — zero tokens, no provider slot:

```typescript
subagent({ name: "tests", command: ["npm", "test"], timeoutMs: 600_000 });
subagent({ name: "lint", command: "npm run lint && npm run typecheck" });
```

An array runs that program with those arguments (no shell syntax); a string runs
through `/bin/sh`. stdout/stderr are captured to
`artifacts/<session>/subagent-output/<name>.log` and the result is the tail of
that file (6&nbsp;000 characters), so a failure at the end of a long log is what
you see. `command` cannot be combined with `agent`/`task`, and a command has no
session, so it cannot be resumed or steered — run it again if you need it again.

## Model fallbacks

An agent can declare the models to try when a run dies on a provider error:

```markdown
---
name: worker
model: openrouter/z-ai/glm-5.3-flash
models: openrouter/z-ai/glm-5.3-flash, openrouter/anthropic/claude-haiku-4.5
---
```

Only provider problems that another model can fix are retried — usage limits,
quota, overload, "no available accounts", 429. Billing failures (402,
insufficient balance) fail immediately, and a clean exit or an ordinary crash is
never retired. The failover continues the **same child session** on the next
model with a note about what failed, so work already on disk is not redone. One
failover per run; the result that finally reaches you is the last attempt's.

## Writer conflicts

A spawn whose agent may `edit`/`write` is recorded as a writer of its worktree.
If another live subagent of the same session already writes there, the spawn
acknowledgement says so. It is a warning, not a lock: parallel workers in one
checkout are the point of this extension, so keeping files disjoint stays your
call. Two pi sessions in the same worktree are not compared (separate
registries).

## Timeouts

A wedged subagent used to be waited on forever. Pass `timeoutMs` per spawn, or
set `timeout:` in an agent's frontmatter (`timeout: 15m`, also `90s`/`30m`/`2h`;
a bare number is milliseconds):

```typescript
subagent({ agent: "worker", task: "…", timeoutMs: 900_000 });
```

On timeout the pane is closed and the outcome is recorded as `timeout` — not a
crash: the work did run. Time spent waiting for you to answer a question does
not count against the budget.

## Surviving a restart

The name registry doubles as a durable record: every spawn writes its pane, agent,
model, task and start time before the pane command is sent, and every phase
change and exit updates it. Herdr keeps owning the panes, so after the parent pi
quits or is killed, the next session on that same session file reads the rows
back and, per subagent:

- **still running** → its pane is adopted: it shows up in the widget again and
  its result is still delivered to you;
- **finished while nobody was listening** → the stored result is replayed once;
- **outcome unknown** (pane gone, no result) → reported as unknown. It is never
  guessed at and never re-run — check the working tree before trusting it.

A session that ends cleanly stops its subagents (no unattended spending) and
leaves them unreported, so the next session tells you what was interrupted. To
recover an interrupted run, resume it by name: `subagent_message({ name })`.

## Requirements

- Pi running inside Herdr (`HERDR_ENV=1`)
- Extension auto-discovers from `~/.pi/agent/extensions/pi-swarm/`

## Tests

`npm test` — restart reconcile decisions, the registry merge/upsert rules, and
the notice formatting (Node ≥ 22.19 strips the types, no build step).

## Reference

- Herdr CLI: `herdr --skill`

## License

MIT. See [LICENSE](./LICENSE).
