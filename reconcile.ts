/**
 * Bookkeeping for subagents whose parent pi session went away.
 *
 * Herdr owns the panes, so a subagent keeps running when the parent exits or
 * crashes. What is lost is the parent's in-memory view of it: the widget, the
 * poll loop, and the delivery of a result nobody was there to receive. The name
 * registry (session.ts) is the durable record — written at spawn before the
 * pane command is sent, merged on every phase change and at exit — so a fresh
 * parent can read it back and decide per entry what to do.
 *
 * The decision is deliberately conservative. A pane that still exists is
 * adopted and watched again. A finished entry whose outcome was never delivered
 * is replayed. Everything else is `unknown`: never guessed, never re-run,
 * because a repeated effect is worse than a missing one.
 *
 * Everything here is pure so it can be tested without herdr, panes, or pi.
 */

export type SubagentPhase =
  | "running"
  | "asking"
  | "done"
  | "error"
  | "timeout"
  /** Stopped deliberately, while the parent was there to hear about it. */
  | "cancelled"
  /** Killed because the parent session exited, with nobody listening. */
  | "stopped"
  | "unknown";

/** One subagent's durable row, as stored in the name registry. */
export interface ReconcileEntry {
  name: string;
  sessionFile: string;
  phase?: SubagentPhase;
  /** Herdr pane id. Absent for rows written before this bookkeeping existed. */
  surface?: string;
  agent?: string | null;
  model?: string | null;
  /** Set for non-pi children ("claude"), which report through a sentinel file. */
  cli?: string;
  sentinelFile?: string;
  /** Command line of a command call: its output file is the result. */
  command?: string;
  outputFile?: string;
  /** Durable exit-code file of a command call. */
  exitFile?: string;
  /** Whether it may write in its worktree (drives writer warnings). */
  writes?: boolean;
  task?: string;
  cwd?: string | null;
  /** Budget in ms, so an adopted pane is still bounded by its original deadline. */
  timeoutMs?: number;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  /** Path of the file holding the final summary text, if it was written. */
  resultFile?: string;
  /**
   * Set once the parent has delivered this entry's outcome into the
   * conversation. A reported entry is never reported again.
   */
  reportedAt?: number;
  /** User-driven sessions (e.g. planner) do not wake the parent on transitions. */
  interactive?: boolean;
}

export type ReconcileAction = "adopt" | "report" | "unknown" | "idle";

/** Phases that mean the subagent is over, whatever its outcome was. */
const TERMINAL_PHASES: ReadonlySet<SubagentPhase> = new Set<SubagentPhase>([
  "done",
  "error",
  "timeout",
  "cancelled",
  "stopped",
]);

/**
 * What to do with one entry. `livePanes` holds the pane ids herdr still owns.
 *
 * - running/asking + live pane → `adopt` (re-attach the watcher)
 * - running/asking + pane gone → `unknown` (it may have died mid-work)
 * - terminal phase, never delivered → `report` (replay the stored outcome)
 * - already delivered, or nothing to say → `idle`
 *
 * A pane that still exists while its process is gone is NOT detectable here,
 * and deliberately not guessed at: a subagent pane runs a bash wrapper, so herdr
 * reports `agent_status: "unknown"` with no agent for a live subagent and a dead
 * one alike (calibrated 2026-10-18 on a running command call). Telling them
 * apart needs a pid recorded at spawn and probed here — recorded as the
 * follow-up, not papered over with a probe that lies.
 */
export function classifyEntry(
  entry: ReconcileEntry,
  livePanes: ReadonlySet<string>,
): ReconcileAction {
  const phase = entry.phase ?? "unknown";

  if (phase === "running" || phase === "asking") {
    if (!entry.surface) return "unknown";
    return livePanes.has(entry.surface) ? "adopt" : "unknown";
  }

  if (phase === "unknown") {
    return entry.reportedAt ? "idle" : "unknown";
  }

  // Terminal phase: the outcome exists but the parent never delivered it.
  return entry.reportedAt ? "idle" : "report";
}

/**
 * The panes to close during a reconcile pass: every live pane a finished entry
 * still owns.
 *
 * This is the other half of the bookkeeping. A pane is otherwise closed only by
 * the parent's own completion path (`closeSurface` after `recordFinish`), so a
 * subagent stopped from outside — the only way to stop a wedged one, since the
 * toolset has no stop — leaves its pane open for good when that path never runs
 * (measured 2026-10-18: a killed planner kept `phase: "running"` and its pane
 * stayed in herdr hours later, and the next boot's policy would have adopted it).
 * Closing by phase keeps the leak to the run that caused it.
 */
export function panesToClose(
  entries: readonly ReconcileEntry[],
  livePanes: ReadonlySet<string>,
): string[] {
  const closing: string[] = [];
  for (const entry of entries) {
    const surface = entry.surface;
    if (!surface || !livePanes.has(surface)) continue;
    if (!TERMINAL_PHASES.has((entry.phase ?? "unknown") as SubagentPhase)) continue;
    if (!closing.includes(surface)) closing.push(surface);
  }
  return closing;
}

export interface ReconcilePlan {
  adopt: ReconcileEntry[];
  report: ReconcileEntry[];
  unknown: ReconcileEntry[];
  idle: ReconcileEntry[];
  /** Pane ids to close: panes a finished entry still holds. */
  close: string[];
}

/** Bucket every entry. Order is preserved within each bucket. */
export function planReconcile(
  entries: ReconcileEntry[],
  livePanes: ReadonlySet<string>,
): ReconcilePlan {
  const plan: ReconcilePlan = {
    adopt: [],
    report: [],
    unknown: [],
    idle: [],
    close: panesToClose(entries, livePanes),
  };
  for (const entry of entries) {
    plan[classifyEntry(entry, livePanes)].push(entry);
  }
  return plan;
}

/**
 * Provider failures that a different model can actually fix. Deliberately
 * excludes billing problems (402, insufficient balance): retrying those on
 * another model would just fail again and cost another run.
 */
const FAILOVER_ERROR_PATTERNS = [
  /usage\s*limit/i,
  /quota/i,
  /rate\s*limit/i,
  /overload/i,
  /no available accounts/i,
  /at capacity/i,
  /\b429\b/,
];

const NON_FAILOVER_ERROR_PATTERNS = [/insufficient/i, /\bbalance\b/i, /\b402\b/, /payment/i];

/**
 * Pick the next model for a run that died on a provider error, or null to let
 * the failure through. One failover per run: a chain of models is a fallback,
 * not a retry loop, and a run that fails on every model has a real problem to
 * report rather than hide.
 */
export function decideFailover(options: {
  errorMessage?: string | null;
  exitCode: number;
  /** Failovers already used by this run. */
  attemptsSoFar?: number;
  /** Models to try, in order. The first unused one wins. */
  fallbacks?: string[];
  maxFailovers?: number;
}): string | null {
  const { errorMessage, exitCode } = options;
  const attemptsSoFar = options.attemptsSoFar ?? 0;
  const maxFailovers = options.maxFailovers ?? 1;
  const fallbacks = options.fallbacks ?? [];

  if (exitCode === 0 || !errorMessage) return null;
  if (attemptsSoFar >= maxFailovers) return null;
  if (NON_FAILOVER_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))) return null;
  if (!FAILOVER_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))) return null;
  return fallbacks[attemptsSoFar] ?? null;
}

/** True when the plan has anything worth waking the session for. */
export function planHasNews(plan: ReconcilePlan): boolean {
  return (
    plan.adopt.length > 0 ||
    plan.report.length > 0 ||
    plan.unknown.length > 0 ||
    plan.close.length > 0
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function label(entry: ReconcileEntry): string {
  return entry.agent && entry.agent !== entry.name
    ? `"${entry.name}" (${entry.agent})`
    : `"${entry.name}"`;
}

function describeFinished(entry: ReconcileEntry, now: number): string {
  const parts: string[] = [entry.phase ?? "done"];
  if (entry.exitCode !== undefined && entry.exitCode !== 0) parts.push(`exit ${entry.exitCode}`);
  if (entry.startedAt && entry.finishedAt) {
    parts.push(`ran ${formatDuration(entry.finishedAt - entry.startedAt)}`);
  }
  if (entry.finishedAt && now > entry.finishedAt) {
    parts.push(`${formatDuration(now - entry.finishedAt)} ago`);
  }
  return parts.join(", ");
}

/**
 * One steer message for the whole reconcile pass — a restart should say
 * everything it knows once, not once per subagent. Returns null when there is
 * nothing to report, so a clean start stays silent.
 */
export function formatReconcileNotice(plan: ReconcilePlan, now = Date.now()): string | null {
  if (!planHasNews(plan)) return null;

  const lines: string[] = [];

  if (plan.report.length > 0) {
    lines.push(
      `Sub-agent work finished while this session was not watching (${plan.report.length}):`,
    );
    for (const entry of plan.report) {
      lines.push(`- ${label(entry)} — ${describeFinished(entry, now)}.`);
    }
  }

  if (plan.adopt.length > 0) {
    lines.push(`Still running and now watched again (${plan.adopt.length}):`);
    for (const entry of plan.adopt) {
      const runningFor = entry.startedAt ? ` ${formatDuration(now - entry.startedAt)}` : "";
      lines.push(`- ${label(entry)} — running${runningFor}, pane ${entry.surface}.`);
    }
  }

  if (plan.unknown.length > 0) {
    lines.push(`Unknown outcome — do not assume it worked (${plan.unknown.length}):`);
    for (const entry of plan.unknown) {
      const elapsed = entry.startedAt ? ` after ${formatDuration(now - entry.startedAt)}` : "";
      lines.push(
        `- ${label(entry)} stopped${elapsed} with no result on record and no live pane. ` +
          `Its edits may be half-finished — inspect the working tree before trusting or re-running it.`,
      );
    }
  }

  if (plan.close.length > 0) {
    lines.push(
      `Pane(s) closed for finished sub-agents: ${plan.close.join(", ")}.`,
    );
  }

  const idle = plan.idle.length > 0 ? ` ${plan.idle.length} earlier subagent(s) already delivered.` : "";
  return lines.join("\n") + idle;
}
