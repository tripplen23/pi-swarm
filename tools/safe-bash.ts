/**
 * Safe bash extension for the worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists `safe_bash`. See CUSTOM_TOOL_EXTENSIONS in ../index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DANGEROUS_PATTERNS = [
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,

	// --- Git: publishing. A worker has no UI, so it cannot be asked, and publishing is
	// the parent's job anyway (AGENTS.md: commits and pushes need an explicit request).
	// Read-only git is untouched: status, diff, log, show, branch, rev-parse, stash list.
	/\bgit\s+commit\b/,
	/\bgit\s+pull\b/,
	/\bgit\s+push\b/,
	/\bgit\s+reset\b[^#\n]*--hard\b/,
	/\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/,
	/\bgit\s+reflog\s+expire\b/,
	/\bgit\s+gc\b[^#\n]*--prune\b/,

	// --- Git: discarding work. Whole-tree wipes and history rewrites only. A
	// file-scoped revert (`git checkout -- path`, `git restore path`) stays allowed,
	// because a worker that broke one file still has to be able to get it back.
	/\bgit\s+checkout\b[^#\n]*(\s--\s*\.\s*($|&&|\||;)|-(f|-force)\b)/,
	/\bgit\s+restore\b[^#\n]*\s(\.|\/)(\s|$)/,
	/\bgit\s+restore\b\s*(#|$|&&|\||;)/,
	/\bgit\s+stash\s+(drop|clear)\b/,
	/\bgit\s+branch\b[^#\n]*\s-D\b/,
	/\bgit\s+rebase\b/,
	/\bgit\s+filter-branch\b/,
];

function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ");
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				throw new Error(danger);
			}
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
