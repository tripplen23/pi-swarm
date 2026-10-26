/**
 * Tests for reading the last assistant reply out of a session transcript.
 * Run: `node --test session.reply.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { findLastAssistantReply } from "./session.ts";

function assistant(over: Record<string, unknown>): any {
  return {
    type: "message",
    id: "e1",
    message: { role: "assistant", content: [{ type: "text", text: "" }], ...over },
  };
}

test("a plain answer reads as text, not an error", () => {
  const reply = findLastAssistantReply([assistant({ content: [{ type: "text", text: "DONE" }] })]);
  assert.deepEqual(reply, { text: "DONE", isError: false });
});

test("a turn that streamed text and then failed keeps the text but is an error", () => {
  // Real shape from a session: partial answer + stopReason error.
  const reply = findLastAssistantReply([
    assistant({
      content: [{ type: "text", text: "## 12/12 finding là thật — đã sửa" }],
      stopReason: "error",
      errorMessage: "Stream ended without finish_reason",
    }),
  ]);
  assert.equal(reply?.isError, true);
  assert.match(reply!.text, /12\/12 finding/);
});

test("an errored turn with no text falls back to its error message", () => {
  const reply = findLastAssistantReply([
    assistant({ content: [], stopReason: "error", errorMessage: "overloaded" }),
  ]);
  assert.deepEqual(reply, { text: "Subagent error: overloaded", isError: true });
});

test("an errored turn with neither text nor message is skipped, not reported as done", () => {
  const reply = findLastAssistantReply([
    assistant({ content: [], stopReason: "error" }),
    assistant({ content: [{ type: "text", text: "EARLIER" }] }),
  ]);
  assert.deepEqual(reply, { text: "EARLIER", isError: false });
});
