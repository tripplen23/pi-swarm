/**
 * Tests for restart reconcile and failover decisions.
 * Run: `node --test reconcile.test.ts` (Node >= 22.19 strips the types).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyEntry,
  decideFailover,
  formatReconcileNotice,
  panesToClose,
  planHasNews,
  planReconcile,
  reconcileReportPatches,
  type ReconcileEntry,
} from "./reconcile.ts";

const LIVE = new Set(["w3:p10", "w3:p11"]);
const NONE = new Set<string>();

function entry(over: Partial<ReconcileEntry> = {}): ReconcileEntry {
  return { name: "scout", sessionFile: "/tmp/scout.jsonl", surface: "w3:p10", ...over };
}

test("a live pane is adopted, running or asking", () => {
  for (const phase of ["running", "asking"] as const) {
    assert.equal(classifyEntry(entry({ phase }), LIVE), "adopt", phase);
  }
});

test("a missing pane or a missing pane id is unknown, never assumed finished", () => {
  assert.equal(classifyEntry(entry({ phase: "running" }), NONE), "unknown");
  assert.equal(classifyEntry(entry({ phase: "asking", surface: "w3:p99" }), LIVE), "unknown");
  assert.equal(classifyEntry(entry({ phase: "running", surface: undefined }), LIVE), "unknown");
});

test("a finished outcome is replayed once, whatever the phase", () => {
  for (const phase of ["done", "error", "timeout", "cancelled", "stopped"] as const) {
    assert.equal(classifyEntry(entry({ phase }), NONE), "report", phase);
    assert.equal(classifyEntry(entry({ phase, reportedAt: 1 }), NONE), "idle", phase);
  }
});

test("a legacy row (no phase) is unknown, not done", () => {
  assert.equal(classifyEntry(entry(), NONE), "unknown");
  assert.equal(classifyEntry(entry({ reportedAt: 1 }), NONE), "idle");
});

test("planReconcile buckets every entry, keeps order, and closes finished panes", () => {
  const plan = planReconcile(
    [
      entry({ name: "a", phase: "done" }),
      entry({ name: "b", phase: "running" }),
      entry({ name: "c", phase: "done", reportedAt: 5 }),
      entry({ name: "d", phase: "running", surface: "w3:gone" }),
      entry({ name: "e", phase: "timeout", surface: "w3:p11" }),
    ],
    LIVE,
  );

  assert.deepEqual(plan.report.map((e) => e.name), ["a", "e"]);
  assert.deepEqual(plan.adopt.map((e) => e.name), ["b"]);
  assert.deepEqual(plan.unknown.map((e) => e.name), ["d"]);
  assert.deepEqual(plan.idle.map((e) => e.name), ["c"]);
  // both finished entries still hold live panes, and duplicates are collapsed
  assert.deepEqual(plan.close, ["w3:p10", "w3:p11"]);
  assert.equal(planHasNews(plan), true);
});

test("panesToClose only closes panes a finished entry still holds", () => {
  assert.deepEqual(panesToClose([entry({ phase: "running" })], LIVE), []);
  assert.deepEqual(panesToClose([entry({ phase: "done", surface: "w3:p99" })], LIVE), []);
  assert.deepEqual(
    panesToClose([entry({ phase: "done" }), entry({ name: "x", phase: "done" })], LIVE),
    ["w3:p10"],
  );
});

test("a plan with nothing new prints nothing", () => {
  assert.equal(formatReconcileNotice(planReconcile([], NONE)), null);
  assert.equal(
    formatReconcileNotice(planReconcile([entry({ phase: "done", reportedAt: 1 })], NONE)),
    null,
  );
});

test("the notice reports phases, runtime, exit codes and live panes", () => {
  const startedAt = 1_000_000;
  const finishedAt = startedAt + 192_000;
  const now = finishedAt + 120_000;

  const notice = formatReconcileNotice(
    planReconcile(
      [
        entry({ name: "worker", agent: "worker", phase: "done", startedAt, finishedAt }),
        entry({ name: "qa", agent: "qa", phase: "error", exitCode: 2, startedAt, finishedAt }),
        entry({ name: "scout", phase: "running", startedAt, surface: "w3:p10" }),
        entry({ name: "researcher", phase: "running", startedAt, surface: "w3:gone" }),
        entry({ name: "old", phase: "done", reportedAt: 1 }),
      ],
      LIVE,
    ),
    now,
  )!;

  assert.match(notice, /finished while this session was not watching \(2\):/);
  assert.match(notice, /- "worker" — done, ran 3m12s, 2m00s ago\./);
  assert.match(notice, /- "qa" — error, exit 2, ran 3m12s, 2m00s ago\./);
  assert.match(notice, /- "scout" — running 5m12s, pane w3:p10\./);
  assert.match(notice, /- "researcher" stopped after 5m12s .*inspect the working tree/);
  assert.match(notice, /1 earlier subagent\(s\) already delivered\./);
  assert.equal(notice.split("\n").filter((line) => line.startsWith("- ")).length, 4);
});

test("reporting an unknown row also clears its stale phase, so a second pass is silent", () => {
  const plan = planReconcile(
    [entry({ name: "dead", phase: "running", surface: "w3:gone" }), entry({ name: "done", phase: "done" })],
    NONE,
  );
  const patches = reconcileReportPatches(plan, 42);
  assert.deepEqual(patches, [
    { name: "done", patch: { reportedAt: 42 } },
    { name: "dead", patch: { reportedAt: 42, phase: "unknown" } },
  ]);

  const patched = [
    entry({ name: "dead", phase: "unknown", surface: "w3:gone", reportedAt: 42 }),
    entry({ name: "done", phase: "done", reportedAt: 42 }),
  ];
  const second = planReconcile(patched, NONE);
  assert.equal(planHasNews(second), false, "second pass must stay silent");
  assert.equal(formatReconcileNotice(second), null);
});

test("failover only for provider errors another model can fix", () => {
  const fallbacks = ["openrouter/backup-a", "openrouter/backup-b"];
  assert.equal(decideFailover({ errorMessage: "Provider overloaded", exitCode: 1, fallbacks }), "openrouter/backup-a");
  assert.equal(decideFailover({ errorMessage: "429 Too Many Requests", exitCode: 1, fallbacks }), "openrouter/backup-a");
  assert.equal(
    decideFailover({ errorMessage: "usage limit reached", exitCode: 1, attemptsSoFar: 1, maxFailovers: 2, fallbacks }),
    "openrouter/backup-b",
  );
});

test("failover never fires on billing errors, clean exits, crashes, or an empty list", () => {
  for (const errorMessage of ["402 Payment Required", "insufficient balance", "payment failed"]) {
    assert.equal(decideFailover({ errorMessage, exitCode: 1, fallbacks: ["b"] }), null, errorMessage);
  }
  assert.equal(decideFailover({ errorMessage: "overloaded", exitCode: 0, fallbacks: ["a"] }), null);
  assert.equal(decideFailover({ errorMessage: null, exitCode: 1, fallbacks: ["a"] }), null);
  assert.equal(decideFailover({ errorMessage: "TypeError: x is not a function", exitCode: 1 }), null);
  assert.equal(decideFailover({ errorMessage: "overloaded", exitCode: 1, fallbacks: [] }), null);
  assert.equal(
    decideFailover({ errorMessage: "overloaded", exitCode: 1, attemptsSoFar: 1, fallbacks: ["a", "b"] }),
    null,
  );
});
