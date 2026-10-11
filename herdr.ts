/**
 * herdr surface layer — the only terminal multiplexer this extension supports.
 *
 * Provides the pane API the rest of the extension uses: create/split a pane,
 * type a command into it, read its screen, rename it, and poll for exit.
 *
 * Panes are identified by Herdr pane ids (e.g. `w3:pG`). Splits target the
 * parent pi's pane (`$HERDR_PANE_ID`) with `--no-focus`, so new panes follow
 * the agent rather than the user's focus.
 *
 * Each pane is renamed to the subagent's display name, so in the Herdr UI
 * (tab bar / sidebar) you can tell at a glance which pane is which agent.
 * Reference: `herdr --skill`.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

function herdrBin(): string {
  return process.env.HERDR_BIN_PATH ?? "herdr";
}

let commandAvailable: boolean | null = null;
function hasHerdrCommand(): boolean {
  if (commandAvailable !== null) return commandAvailable;
  try {
    execFileSync("sh", ["-c", `command -v ${herdrBin()}`], { stdio: "ignore" });
    commandAvailable = true;
  } catch {
    commandAvailable = false;
  }
  return commandAvailable;
}

/**
 * True when running inside a Herdr-managed pane with the herdr binary on PATH.
 * `HERDR_ENV=1` is set by Herdr in every process it spawns.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasHerdrCommand();
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside Herdr (run `herdr`, then start pi in a pane).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Herdr plumbing ──

/** Run a herdr command that returns a JSON envelope and parse it. */
function herdrJson(args: string[]): any {
  const out = execFileSync(herdrBin(), args, { encoding: "utf8" });
  const trimmed = out.trim();
  return trimmed ? JSON.parse(trimmed) : {};
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane.
 * Returns the new pane id (e.g. `w3:pG`). The pane is renamed to `name`.
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right", process.env.HERDR_PANE_ID);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Herdr splits support only `right` and `down`; `left`/`up` map to their
 * right/down counterpart. Returns the new pane id.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  requireHerdr();

  const dir = direction === "left" ? "right" : direction === "up" ? "down" : direction;
  const args = ["pane", "split", "--direction", dir, "--cwd", process.cwd(), "--no-focus"];
  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }

  const pane: string | undefined = herdrJson(args)?.result?.pane?.pane_id;
  if (!pane) {
    throw new Error(`Unexpected herdr pane split output for ${name}`);
  }

  // Label the pane so the Herdr UI distinguishes agents; best-effort.
  try {
    execFileSync(herdrBin(), ["pane", "rename", pane, name], { encoding: "utf8" });
  } catch {
    // Cosmetic label only.
  }

  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * `herdr pane run` sends the text and Enter atomically.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execFileSync(herdrBin(), ["pane", "run", surface, command], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * Avoids terminal line-wrapping issues for commands longer than the pane width.
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 * Uses the `visible` snapshot: reliable for freshly created panes, where the
 * `recent`/`recent-unwrapped` scrollback is still empty.
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return execFileSync(
    herdrBin(),
    ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    herdrBin(),
    ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane. Non-fatal when the pane is already gone.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  try {
    execFileSync(herdrBin(), ["pane", "close", surface], { encoding: "utf8" });
  } catch {
    // Pane may already be closed.
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Clean completions write no sidecar and are detected via
 * the terminal sentinel instead.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 8);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
