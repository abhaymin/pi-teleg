/**
 * Telegram → Pi system controls.
 *
 * Built-in interactive slash commands like /model are TUI-only and do not run
 * via sendUserMessage. This module binds the ExtensionAPI equivalents so
 * authorized Telegram users can drive the same session controls remotely.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type PiSysReply = { handled: true; reply: string } | { handled: false };

const THINK_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
type ThinkLevel = (typeof THINK_LEVELS)[number];

const HELP = [
	"<b>Pi system commands</b> (this session)",
	"",
	"<code>/pi</code> — this help",
	"<code>/model</code> — current model",
	"<code>/models [query]</code> — list models",
	"<code>/model &lt;provider/id|id&gt;</code> — switch model",
	"<code>/think</code> — current thinking level",
	"<code>/think &lt;off|minimal|low|medium|high|xhigh&gt;</code>",
	"<code>/compact [instructions]</code> — compact context",
	"<code>/tools</code> — active tools",
	"<code>/tools all</code> — all configured tools",
	"<code>/tools set a b c</code> — set active tools",
	"<code>/cmds [query]</code> — extension / skill / prompt commands",
	"<code>/cmd &lt;name&gt; [args]</code> — run a listed command (best-effort)",
	"<code>/agent &lt;task&gt;</code> — focused sub-task for the agent / sub-agents",
	"<code>/orchestrate &lt;task&gt;</code> — multi-session orchestration (delegates to sub-agents)",
	"<code>/session</code> — session + model + thinking snapshot",
	"<code>/new [kickoff]</code> — new Pi session (when API allows)",
	"<code>/reload</code> — reload extensions/skills (when API allows)",
	"<code>stop</code> — abort active turn",
	"",
	"Also: existing teleg commands (/status, /health, …).",
].join("\n");

function isThinkLevel(s: string): s is ThinkLevel {
	return (THINK_LEVELS as readonly string[]).includes(s);
}

function modelLabel(
	model: { provider?: string; id?: string; name?: string } | undefined,
): string {
	if (!model) return "(none)";
	const id = model.id ?? "?";
	const provider = model.provider ?? "?";
	const name = model.name && model.name !== id ? ` — ${model.name}` : "";
	return `${provider}/${id}${name}`;
}

function scoreModelMatch(
	query: string,
	provider: string,
	id: string,
	name?: string,
): number {
	const q = query.toLowerCase();
	const full = `${provider}/${id}`.toLowerCase();
	const idL = id.toLowerCase();
	const nameL = (name ?? "").toLowerCase();
	if (full === q || idL === q) return 100;
	if (full.endsWith(`/${q}`)) return 90;
	if (idL.startsWith(q) || full.startsWith(q)) return 70;
	if (idL.includes(q) || full.includes(q) || nameL.includes(q)) return 40;
	return 0;
}

function listModels(ctx: ExtensionContext, query?: string, limit = 40): string {
	const scoped =
		(
			ctx as ExtensionContext & {
				scopedModels?: Array<{
					model: { provider: string; id: string; name?: string };
				}>;
			}
		).scopedModels ?? [];
	const catalogue =
		scoped.length > 0
			? scoped.map((e) => e.model)
			: ctx.modelRegistry.getAvailable();
	const q = query?.trim().toLowerCase();
	let rows = catalogue.map((m) => ({
		m,
		score: q ? scoreModelMatch(q, m.provider, m.id, m.name) : 1,
	}));
	if (q)
		rows = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
	else
		rows.sort((a, b) =>
			`${a.m.provider}/${a.m.id}`.localeCompare(`${b.m.provider}/${b.m.id}`),
		);
	if (rows.length === 0)
		return q
			? `No models matching <code>${escapeHtml(query!)}</code>.`
			: "No models available.";
	const shown = rows.slice(0, limit);
	const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
	const lines = shown.map(({ m }) => {
		const key = `${m.provider}/${m.id}`;
		const mark = key === cur ? " ✅" : "";
		return `• <code>${escapeHtml(key)}</code>${mark}`;
	});
	const more = rows.length > limit ? `\n… +${rows.length - limit} more` : "";
	const scopeNote = scoped.length > 0 ? " (scoped)" : "";
	return (
		[`<b>Models${scopeNote}</b> (${rows.length}):`, "", ...lines].join("\n") +
		more
	);
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type CmdCtxExtras = {
	newSession?: (options?: {
		parentSession?: string;
		withSession?: (c: ExtensionContext) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	reload?: () => Promise<void>;
	fork?: (
		entryId: string,
		options?: { position?: "before" | "at" },
	) => Promise<{ cancelled: boolean }>;
};

function asCmdCtx(ctx: ExtensionContext): ExtensionContext & CmdCtxExtras {
	return ctx as ExtensionContext & CmdCtxExtras;
}

/**
 * Try to handle a Pi system command from an authorized Telegram message.
 * `rawText` is the message text (not lowercased); `lower` is normalized lowercase.
 */
export async function tryHandlePiSysCommand(opts: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	rawText: string;
	lower: string;
	/** Async notify for long-running ops (e.g. compact complete). */
	notify?: (message: string) => void | Promise<void>;
}): Promise<PiSysReply> {
	const { pi, ctx, rawText, lower, notify } = opts;
	const trimmed = rawText.trim();
	const lowerTrim = lower.trim();

	// /pi and /pi help
	if (
		lowerTrim === "/pi" ||
		lowerTrim === "/pi help" ||
		lowerTrim === "/sys" ||
		lowerTrim === "/sys help"
	) {
		return { handled: true, reply: HELP };
	}

	// /session snapshot
	if (lowerTrim === "/session" || lowerTrim === "/pi session") {
		const usage = ctx.getContextUsage?.();
		const think = pi.getThinkingLevel();
		const tools = pi.getActiveTools();
		const lines = [
			`<b>Session</b>`,
			`name: <code>${escapeHtml(pi.getSessionName() ?? "(unnamed)")}</code>`,
			`model: <code>${escapeHtml(modelLabel(ctx.model))}</code>`,
			`thinking: <code>${think}</code>`,
			`idle: ${ctx.isIdle() ? "yes" : "no"}`,
			`active tools: ${tools.length}`,
		];
		if (usage && typeof usage === "object") {
			const tokens =
				(usage as { tokens?: number; estimatedTokens?: number }).tokens ??
				(usage as { estimatedTokens?: number }).estimatedTokens;
			if (tokens != null) lines.push(`context tokens: ~${tokens}`);
		}
		return { handled: true, reply: lines.join("\n") };
	}

	// /models [query]
	if (lowerTrim === "/models" || lowerTrim.startsWith("/models ")) {
		const q = trimmed.replace(/^\/models\s*/i, "").trim();
		return { handled: true, reply: listModels(ctx, q || undefined) };
	}

	// /model …
	if (lowerTrim === "/model" || lowerTrim.startsWith("/model ")) {
		const rest = trimmed.replace(/^\/model\s*/i, "").trim();
		if (
			!rest ||
			rest.toLowerCase() === "show" ||
			rest.toLowerCase() === "current"
		) {
			return {
				handled: true,
				reply: `<b>Current model</b>\n<code>${escapeHtml(modelLabel(ctx.model))}</code>\nthinking: <code>${pi.getThinkingLevel()}</code>`,
			};
		}
		if (
			rest.toLowerCase() === "list" ||
			rest.toLowerCase().startsWith("list ")
		) {
			const q = rest.replace(/^list\s*/i, "").trim();
			return { handled: true, reply: listModels(ctx, q || undefined) };
		}
		const setArg = rest.replace(/^set\s+/i, "").trim();
		return { handled: true, reply: await setModelFromQuery(pi, ctx, setArg) };
	}

	// /think[ing] …
	if (
		lowerTrim === "/think" ||
		lowerTrim.startsWith("/think ") ||
		lowerTrim === "/thinking" ||
		lowerTrim.startsWith("/thinking ")
	) {
		const rest = trimmed
			.replace(/^\/think(ing)?\s*/i, "")
			.trim()
			.toLowerCase();
		if (!rest) {
			return {
				handled: true,
				reply: `Thinking level: <code>${pi.getThinkingLevel()}</code>\nLevels: ${THINK_LEVELS.join(", ")}`,
			};
		}
		if (!isThinkLevel(rest)) {
			return {
				handled: true,
				reply: `Unknown level <code>${escapeHtml(rest)}</code>. Use: ${THINK_LEVELS.join(", ")}`,
			};
		}
		pi.setThinkingLevel(rest);
		return {
			handled: true,
			reply: `Thinking level set to <code>${pi.getThinkingLevel()}</code>.`,
		};
	}

	// /compact [instructions]  (also reachable as legacy handler; we claim it here)
	if (lowerTrim === "/compact" || lowerTrim.startsWith("/compact ")) {
		if (!ctx.isIdle()) {
			return {
				handled: true,
				reply: "Cannot compact while busy. Send <code>stop</code> first.",
			};
		}
		const instructions = trimmed.replace(/^\/compact\s*/i, "").trim();
		ctx.compact({
			customInstructions: instructions || undefined,
			onComplete: () => {
				void notify?.("Compaction completed.");
			},
			onError: (err) => {
				void notify?.(
					`Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			},
		});
		return {
			handled: true,
			reply: instructions
				? `Compaction started with custom instructions.`
				: `Compaction started.`,
		};
	}

	// /tools …
	if (lowerTrim === "/tools" || lowerTrim.startsWith("/tools ")) {
		const rest = trimmed.replace(/^\/tools\s*/i, "").trim();
		const lowerRest = rest.toLowerCase();
		if (!rest) {
			const active = pi.getActiveTools();
			if (active.length === 0)
				return { handled: true, reply: "No active tools." };
			return {
				handled: true,
				reply: [
					`<b>Active tools</b> (${active.length}):`,
					"",
					...active.map((t) => `• <code>${escapeHtml(t)}</code>`),
				].join("\n"),
			};
		}
		if (lowerRest === "all") {
			const all = pi.getAllTools();
			const lines = all
				.slice(0, 60)
				.map((t) => `• <code>${escapeHtml(t.name)}</code>`);
			const more = all.length > 60 ? `\n… +${all.length - 60} more` : "";
			return {
				handled: true,
				reply:
					[`<b>All tools</b> (${all.length}):`, "", ...lines].join("\n") + more,
			};
		}
		if (lowerRest.startsWith("set ")) {
			const names = rest
				.slice(4)
				.split(/[\s,]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			if (names.length === 0)
				return {
					handled: true,
					reply: "Usage: <code>/tools set tool1 tool2 …</code>",
				};
			pi.setActiveTools(names);
			return {
				handled: true,
				reply: `Active tools set (${pi.getActiveTools().length}): ${pi.getActiveTools().map(escapeHtml).join(", ")}`,
			};
		}
		return {
			handled: true,
			reply:
				"Usage: <code>/tools</code> | <code>/tools all</code> | <code>/tools set a b c</code>",
		};
	}

	// /cmds [query]
	if (
		lowerTrim === "/cmds" ||
		lowerTrim.startsWith("/cmds ") ||
		lowerTrim === "/commands" ||
		lowerTrim.startsWith("/commands ")
	) {
		const q = trimmed
			.replace(/^\/(cmds|commands)\s*/i, "")
			.trim()
			.toLowerCase();
		let cmds = pi.getCommands();
		if (q)
			cmds = cmds.filter(
				(c) =>
					c.name.toLowerCase().includes(q) ||
					(c.description ?? "").toLowerCase().includes(q),
			);
		cmds = cmds.slice().sort((a, b) => a.name.localeCompare(b.name));
		if (cmds.length === 0)
			return { handled: true, reply: "No matching commands." };
		const lines = cmds.slice(0, 50).map((c) => {
			const desc = c.description ? ` — ${escapeHtml(c.description)}` : "";
			return `• <code>/${escapeHtml(c.name)}</code> <i>(${c.source})</i>${desc}`;
		});
		const more = cmds.length > 50 ? `\n… +${cmds.length - 50} more` : "";
		return {
			handled: true,
			reply:
				[
					`<b>Invokable commands</b> (${cmds.length}):`,
					"Use <code>/cmd name args</code>",
					"",
					...lines,
				].join("\n") + more,
		};
	}

	// /cmd <name> [args] — best-effort via agent (sendUserMessage skips slash expand)
	if (lowerTrim.startsWith("/cmd ")) {
		const rest = trimmed.replace(/^\/cmd\s+/i, "").trim();
		if (!rest)
			return {
				handled: true,
				reply: "Usage: <code>/cmd &lt;name&gt; [args]</code>",
			};
		const space = rest.search(/\s/);
		const name = (space === -1 ? rest : rest.slice(0, space)).replace(
			/^\//,
			"",
		);
		const args = space === -1 ? "" : rest.slice(space).trim();
		const known = pi
			.getCommands()
			.find((c) => c.name === name || c.name === `${name}`);
		if (!known) {
			return {
				handled: true,
				reply: `Unknown command <code>/${escapeHtml(name)}</code>. Try <code>/cmds</code>.`,
			};
		}
		if (!ctx.isIdle()) {
			return {
				handled: true,
				reply:
					"Agent busy. Send <code>stop</code> first, then retry <code>/cmd</code>.",
			};
		}
		const payload =
			`[telegram-sys] The user invoked Pi command /${name}${args ? ` ${args}` : ""}.\n` +
			`Source: ${known.source}. Description: ${known.description ?? "(none)"}.\n` +
			`Execute this command's intent now. If it is a skill or prompt template, apply it fully. ` +
			`If you need a real sub-agent tool, use it. Reply with the outcome.`;
		pi.sendUserMessage(payload);
		return {
			handled: true,
			reply: `Running <code>/${escapeHtml(name)}</code> (${known.source}) in this session…`,
		};
	}

	// /agent <task> — focused sub-task / sub-agent style steer
	if (lowerTrim === "/agent" || lowerTrim.startsWith("/agent ")) {
		const task = trimmed.replace(/^\/agent\s*/i, "").trim();
		if (!task)
			return {
				handled: true,
				reply: "Usage: <code>/agent &lt;task&gt;</code>",
			};
		const payload =
			`[telegram-sys] Focused sub-task from Telegram. Treat this as a bounded agent job` +
			` (use sub-agent / delegate tools if available). Do not expand scope.\n\nTASK:\n${task}`;
		if (!ctx.isIdle()) {
			pi.sendUserMessage(payload, { deliverAs: "followUp" });
			return {
				handled: true,
				reply: "Queued focused task as follow-up (agent busy).",
			};
		}
		pi.sendUserMessage(payload);
		return { handled: true, reply: "Focused task sent to the agent." };
	}

	// /orchestrate <task> — multi-session orchestration
	if (lowerTrim === "/orchestrate" || lowerTrim.startsWith("/orchestrate ")) {
		const taskText = trimmed.replace(/^\/orchestrate\s*/i, "").trim();
		if (!taskText)
			return {
				handled: true,
				reply: "Usage: <code>/orchestrate &lt;task&gt;</code>",
			};
		// Check if we have the orchestrator module
		try {
			const { runOrchestration } = await import("./orchestrator.js");
			const sessionName = pi.getSessionName() ?? "default";
			const result = await runOrchestration({
				botId: 0, // not used in broadcast mode
				text: taskText,
				sourceSession: sessionName,
				chatId: 0, // Telegram chat ID (0 for Pi-direct calls)
				messageId: 0, // Telegram message ID (0 for Pi-direct calls)
				notify: async (msg) => {
					await notify?.(msg);
				},
			});
			return { handled: true, reply: result.formatted };
		} catch (err) {
			return { handled: true, reply: `Orchestration failed: ${err}` };
		}
	}

	// /new [kickoff]
	if (lowerTrim === "/new" || lowerTrim.startsWith("/new ")) {
		const kickoff = trimmed.replace(/^\/new\s*/i, "").trim();
		const cmd = asCmdCtx(ctx);
		if (typeof cmd.newSession !== "function") {
			return {
				handled: true,
				reply:
					"New session is not available on this Pi context. Use <code>/new</code> in the Pi TUI.",
			};
		}
		if (!ctx.isIdle()) {
			return {
				handled: true,
				reply:
					"Cannot start a new session while busy. Send <code>stop</code> first.",
			};
		}
		const result = await cmd.newSession({
			withSession: async (newCtx) => {
				if (kickoff) {
					// Replacement context may expose sendUserMessage
					const nc = newCtx as ExtensionContext & {
						sendUserMessage?: typeof pi.sendUserMessage;
					};
					if (typeof nc.sendUserMessage === "function") {
						await nc.sendUserMessage(kickoff);
					} else {
						pi.sendUserMessage(kickoff);
					}
				}
			},
		});
		if (result.cancelled)
			return { handled: true, reply: "New session cancelled." };
		return {
			handled: true,
			reply: kickoff
				? "New session started; kickoff sent."
				: "New session started.",
		};
	}

	// /reload
	if (lowerTrim === "/reload") {
		const cmd = asCmdCtx(ctx);
		if (typeof cmd.reload !== "function") {
			return {
				handled: true,
				reply:
					"Reload is not available on this Pi context. Use <code>/reload</code> in the Pi TUI.",
			};
		}
		await cmd.reload();
		return {
			handled: true,
			reply: "Reloaded extensions, skills, prompts, and themes.",
		};
	}

	return { handled: false };
}

async function setModelFromQuery(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	query: string,
): Promise<string> {
	const q = query.trim();
	if (!q)
		return "Usage: <code>/model provider/id</code> or <code>/model id</code>";

	let provider: string | undefined;
	let id: string | undefined;
	if (q.includes("/")) {
		const idx = q.indexOf("/");
		provider = q.slice(0, idx);
		id = q.slice(idx + 1);
	}

	type RegModel = NonNullable<
		ReturnType<ExtensionContext["modelRegistry"]["find"]>
	>;
	let model: RegModel | undefined =
		provider && id ? ctx.modelRegistry.find(provider, id) : undefined;
	if (!model) {
		const scoped =
			(ctx as ExtensionContext & { scopedModels?: Array<{ model: RegModel }> })
				.scopedModels ?? [];
		const catalogue: RegModel[] =
			scoped.length > 0
				? scoped.map((e) => e.model)
				: ctx.modelRegistry.getAvailable();
		const ranked = catalogue
			.map((m) => ({ m, score: scoreModelMatch(q, m.provider, m.id, m.name) }))
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score);
		if (ranked.length === 0) {
			return `No model matching <code>${escapeHtml(q)}</code>. Try <code>/models ${escapeHtml(q)}</code>.`;
		}
		if (
			ranked.length > 1 &&
			ranked[0].score === ranked[1].score &&
			ranked[0].score < 90
		) {
			const top = ranked
				.slice(0, 8)
				.map(
					(r) => `• <code>${escapeHtml(r.m.provider + "/" + r.m.id)}</code>`,
				);
			return [
				`Ambiguous match for <code>${escapeHtml(q)}</code>:`,
				"",
				...top,
				"",
				"Pass <code>provider/id</code>.",
			].join("\n");
		}
		model = ranked[0].m;
	}

	const ok = await pi.setModel(model);
	if (!ok) {
		return `Failed to set <code>${escapeHtml(model.provider + "/" + model.id)}</code> (missing API key?).`;
	}
	return `Model set to <code>${escapeHtml(modelLabel(ctx.model ?? model))}</code>.\nthinking: <code>${pi.getThinkingLevel()}</code>`;
}

/** Whether `lower` looks like a Pi system command we own (including /compact). */
export function isPiSysCommand(lower: string): boolean {
	const t = lower.trim();
	const heads = [
		"/pi",
		"/sys",
		"/model",
		"/models",
		"/think",
		"/thinking",
		"/compact",
		"/tools",
		"/cmds",
		"/commands",
		"/cmd",
		"/agent",
		"/orchestrate",
		"/session",
		"/new",
		"/reload",
	];
	return heads.some((h) => t === h || t.startsWith(h + " "));
}
