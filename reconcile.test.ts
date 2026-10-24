/**
 * Tests for the restart reconcile logic. Run: `node --test reconcile.test.ts`
 * (Node >= 22.19 strips the types itself).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyEntry,
  decideFailover,
  formatReconcileNotice,
  planHasNews,
  planReconcile,
  type ReconcileEntry,
} from "./reconcile.ts";

const LIVE = new Set(["w3:p10", "w3:p11"]);
const NONE = new Set<string>();

function entry(over: Partial<ReconcileEntry> = {}): ReconcileEntry {
  return { name: "scout", sessionFile: "/tmp/scout.jsonl", surface: "w3:p10", ...over };
}

test("running with a live pane is adopted", () => {
  assert.equal(classifyEntry(entry({ phase: "running" }), LIVE), "adopt");
});

test("asking with a live pane is adopted", () => {
  assert.equal(classifyEntry(entry({ phase: "asking" }), LIVE), "adopt");
});

test("running whose pane is gone is unknown, never assumed finished", () => {
  assert.equal(classifyEntry(entry({ phase: "running" }), NONE), "unknown");
  assert.equal(classifyEntry(entry({ phase: "asking", surface: "w3:p99" }), LIVE), "unknown");
});

test("running without a recorded pane is unknown rather than adopted", () => {
  assert.equal(classifyEntry(entry({ phase: "running", surface: undefined }), LIVE), "unknown");
});

test("finished outcomes are replayed once", () => {
  for (const phase of ["done", "error", "timeout", "cancelled", "stopped"] as const) {
    assert.equal(classifyEntry(entry({ phase }), NONE), "report", phase);
    assert.equal(classifyEntry(entry({ phase, reportedAt: 1 }), NONE), "idle", phase);
  }
});

test("a row written before this bookkeeping existed is unknown, not done", () => {
  assert.equal(classifyEntry(entry(), NONE), "unknown");
  assert.equal(classifyEntry(entry({ reportedAt: 1 }), NONE), "idle");
});

test("planReconcile buckets every entry and keeps order inside a bucket", () => {
  const plan = planReconcile(
    [
      entry({ name: "a", phase: "done" }),
      entry({ name: "b", phase: "running" }),
      entry({ name: "c", phase: "done", reportedAt: 5 }),
      entry({ name: "d", phase: "running", surface: "w3:gone" }),
      entry({ name: "e", phase: "timeout" }),
    ],
    LIVE,
  );

  assert.deepEqual(plan.report.map((e) => e.name), ["a", "e"]);
  assert.deepEqual(plan.adopt.map((e) => e.name), ["b"]);
  assert.deepEqual(plan.unknown.map((e) => e.name), ["d"]);
  assert.deepEqual(plan.idle.map((e) => e.name), ["c"]);
  assert.equal(planHasNews(plan), true);
});

test("a finished entry's lingering pane is closed; a running entry's is left alone", () => {
  const plan = planReconcile(
    [
      entry({ name: "done", phase: "done" }),
      // Delivered already, but the pane is still useless: a leaked pane is
      // closed whoever heard the outcome.
      entry({ name: "reported", phase: "done", reportedAt: 1 }),
      entry({ name: "stopped", phase: "stopped", surface: "w3:p11" }),
      entry({ name: "running", phase: "running", surface: "w3:p11" }),
      entry({ name: "gone", phase: "done", surface: "w3:gone" }),
    ],
    LIVE,
  );

  assert.deepEqual(plan.close, ["w3:p10", "w3:p11"]);
});

test("a leaked pane alone is news, so the pass that closes it runs", () => {
  const plan = planReconcile([entry({ phase: "done", reportedAt: 1 })], LIVE);
  assert.deepEqual(plan.close, ["w3:p10"]);
  assert.equal(planHasNews(plan), true);
  assert.match(
    formatReconcileNotice(plan, Date.now())!,
    /Pane\(s\) closed for finished sub-agents: w3:p10\./,
  );
});

test("a plan with only delivered entries has no news and prints nothing", () => {
  const plan = planReconcile([entry({ phase: "done", reportedAt: 1 })], NONE);
  assert.equal(planHasNews(plan), false);
  assert.equal(formatReconcileNotice(plan), null);
});

test("an empty plan prints nothing", () => {
  assert.equal(formatReconcileNotice(planReconcile([], NONE)), null);
});

test("the notice reports phases, runtime, exit codes and live panes", () => {
  const startedAt = 1_000_000;
  const finishedAt = startedAt + 192_000; // 3m12s
  const now = finishedAt + 120_000; // 2m ago

  const plan = planReconcile(
    [
      entry({ name: "worker", agent: "worker", phase: "done", startedAt, finishedAt }),
      entry({ name: "qa", agent: "qa", phase: "error", exitCode: 2, startedAt, finishedAt }),
      entry({ name: "scout", phase: "running", startedAt, surface: "w3:p10" }),
      entry({ name: "researcher", phase: "running", startedAt, surface: "w3:gone" }),
    ],
    LIVE,
  );
  const notice = formatReconcileNotice(plan, now)!;

  assert.match(notice, /finished while this session was not watching \(2\):/);
  assert.match(notice, /- "worker" — done, ran 3m12s, 2m00s ago\./);
  assert.match(notice, /- "qa" — error, exit 2, ran 3m12s, 2m00s ago\./);
  assert.match(notice, /Still running and now watched again \(1\):\n- "scout" — running 5m12s, pane w3:p10\./);
  assert.match(notice, /Unknown outcome — do not assume it worked \(1\):/);
  assert.match(notice, /- "researcher" stopped after 5m12s with no result on record and no live pane/);
  assert.match(notice, /inspect the working tree before trusting or re-running it/);
});

test("an adopted entry without a recorded start time still formats", () => {
  const plan = planReconcile([entry({ name: "scout", phase: "asking" })], LIVE);
  const notice = formatReconcileNotice(plan, Date.now())!;
  assert.match(notice, /- "scout" — running, pane w3:p10\./);
});

test("delivered entries are counted in one trailing sentence, not listed", () => {
  const plan = planReconcile(
    [entry({ name: "a", phase: "done", reportedAt: 1 }), entry({ name: "b", phase: "timeout" })],
    NONE,
  );
  const notice = formatReconcileNotice(plan, Date.now())!;
  assert.equal(notice.split("\n").filter((l) => l.startsWith("- ")).length, 1);
  assert.match(notice, /1 earlier subagent\(s\) already delivered\./);
});

// ── Model failover ──

test("a quota or overload failure moves to the next model on the list", () => {
  const fallbacks = ["openrouter/backup-a", "openrouter/backup-b"];
  assert.equal(
    decideFailover({ errorMessage: "Provider overloaded, try again later", exitCode: 1, fallbacks }),
    "openrouter/backup-a",
  );
  assert.equal(
    decideFailover({ errorMessage: "429 Too Many Requests", exitCode: 1, fallbacks }),
    "openrouter/backup-a",
  );
  assert.equal(
    decideFailover({
      errorMessage: "usage limit reached for this account",
      exitCode: 1,
      fallbacks,
    }),
    "openrouter/backup-a",
  );
  assert.equal(
    decideFailover({
      errorMessage: "usage limit reached",
      exitCode: 1,
      attemptsSoFar: 1,
      maxFailovers: 2,
      fallbacks,
    }),
    "openrouter/backup-b",
  );
});

test("billing failures are never retried on another model", () => {
  for (const errorMessage of [
    "402 Payment Required",
    "insufficient balance",
    "your account balance is too low",
  ]) {
    assert.equal(decideFailover({ errorMessage, exitCode: 1, fallbacks: ["b"] }), null, errorMessage);
    assert.equal(
      decideFailover({ errorMessage, exitCode: 1, attemptsSoFar: 1, fallbacks: ["a", "b"] }),
      null,
      errorMessage,
    );
  }
});

test("one failover per run by default, and never past the list", () => {
  assert.equal(
    decideFailover({ errorMessage: "overloaded", exitCode: 1, attemptsSoFar: 1, fallbacks: ["a", "b"] }),
    null,
  );
  assert.equal(
    decideFailover({
      errorMessage: "overloaded",
      exitCode: 1,
      attemptsSoFar: 1,
      maxFailovers: 2,
      fallbacks: ["a", "b"],
    }),
    "b",
  );
  assert.equal(
    decideFailover({
      errorMessage: "overloaded",
      exitCode: 1,
      attemptsSoFar: 0,
      maxFailovers: 5,
      fallbacks: [],
    }),
    null,
  );
});

test("a clean exit, an ordinary crash, or no fallbacks never trigger failover", () => {
  assert.equal(decideFailover({ errorMessage: "overloaded", exitCode: 0, fallbacks: ["a"] }), null);
  assert.equal(decideFailover({ errorMessage: null, exitCode: 1, fallbacks: ["a"] }), null);
  assert.equal(decideFailover({ errorMessage: "TypeError: x is not a function", exitCode: 1 }), null);
  assert.equal(decideFailover({ errorMessage: "overloaded", exitCode: 1, fallbacks: [] }), null);
});
