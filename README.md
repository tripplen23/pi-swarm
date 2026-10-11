# interactive-subagents

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
| **researcher** | `opencode-go/deepseek-v4.1-flash` | web_search, web_fetch, safe_bash | Web research → sourced brief |
| **worker** | `opencode-go/deepseek-v4.1-flash` | read, write, edit, bash, web_search, web_fetch (+ spawns scout/researcher) | Implementer |
| **reviewer** | `opencode-go/muse-spark-1.3-contributor` | read, grep, find, ls, safe_bash | Read-only code review |

Model rationale:

- **scout** — mechanical locate-and-report. `deepseek-v4-flash` is the cheapest,
  fastest model with a 1M window; matches the low-thinking recon job.
- **researcher / worker** — agentic, multi-step, long outputs. `deepseek-v4.1-flash`
  has a 384K output budget and strong tool use.
- **reviewer** — read-only, bounded output. `muse-spark-1.3-contributor` is an
  affordable 1M-context model; review is a good fit for a cheaper tier.

Override per spawn with `subagent({ agent, model })`, or edit the frontmatter.

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

## Requirements

- Pi running inside Herdr (`HERDR_ENV=1`)
- Extension auto-discovers from `~/.pi/agent/extensions/interactive-subagents/`

## Reference

- Herdr CLI: `herdr --skill`

## License

MIT. See [LICENSE](./LICENSE).
