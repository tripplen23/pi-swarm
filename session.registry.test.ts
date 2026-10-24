/**
 * Tests for the durable name registry: the row a parent reads back after it
 * quits or crashes. Run: `node --test session.registry.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listNameRegistry,
  nameRegistryPath,
  readNameRegistry,
  registerName,
  updateNameRegistry,
} from "./session.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-swarm-registry-"));
}

test("a spawn row and later phase updates merge instead of clobbering", () => {
  const dir = tempDir();

  registerName(dir, "scout", {
    sessionFile: "/tmp/sessions/scout.jsonl",
    sessionId: null,
    surface: "w3:p10",
    phase: "running",
    task: "map the auth module",
    startedAt: 1000,
    updatedAt: 1000,
  });

  // The tool registers the name once the child session id is known.
  registerName(dir, "scout", { sessionFile: "/tmp/sessions/scout.jsonl", sessionId: "sess-1" });
  assert.equal(readNameRegistry(dir).scout.sessionId, "sess-1");

  // Phase changes keep everything that was there before.
  assert.equal(updateNameRegistry(dir, "scout", { phase: "asking", updatedAt: 2000 }), true);
  const row = readNameRegistry(dir).scout;
  assert.equal(row.phase, "asking");
  assert.equal(row.surface, "w3:p10");
  assert.equal(row.task, "map the auth module");
  assert.equal(row.sessionId, "sess-1");
  assert.equal(row.updatedAt, 2000);
});

test("updateNameRegistry never invents a row for an unknown name", () => {
  const dir = tempDir();
  assert.equal(updateNameRegistry(dir, "ghost", { phase: "done" }), false);
  assert.deepEqual(readNameRegistry(dir), {});
});

test("listNameRegistry returns names and skips entries without a session file", () => {
  const dir = tempDir();
  registerName(dir, "worker", { sessionFile: "/tmp/worker.jsonl", sessionId: "w" });
  registerName(dir, "broken", { sessionFile: undefined as unknown as string, sessionId: null });

  const listed = listNameRegistry(dir);
  assert.deepEqual(listed.map((entry) => entry.name), ["worker"]);
  assert.equal(listed[0].sessionFile, "/tmp/worker.jsonl");
});

test("unusable registry payloads read as empty instead of throwing", () => {
  const dir = tempDir();
  for (const payload of ["{ not json", JSON.stringify(["nope"]), JSON.stringify("nope")]) {
    writeFileSync(nameRegistryPath(dir), payload, "utf8");
    assert.deepEqual(readNameRegistry(dir), {}, payload);
    assert.equal(updateNameRegistry(dir, "scout", { phase: "done" }), false);
  }
});

test("registry writes are complete: the file always parses as JSON", () => {
  const dir = tempDir();
  for (let i = 0; i < 5; i += 1) {
    registerName(dir, `agent-${i}`, { sessionFile: `/tmp/a${i}.jsonl`, sessionId: `s${i}` });
  }
  const parsed = JSON.parse(readFileSync(nameRegistryPath(dir), "utf8"));
  assert.equal(Object.keys(parsed).length, 5);
});
