import type { Message, Tool, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	convertToLlm,
	estimateTokens,
	getAgentDir,
	sessionEntryToContextMessages,
	truncateHead,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	activeRejectionTokens,
	deriveSummary,
	deriveTitle,
	forceHeadroom,
	frontmatter,
	hitTime,
	indexEntryLines,
	isForcedCompaction,
	isSafeRecordPath,
	nextSequence,
	parseSummary,
	parseRipgrepHits,
	shouldAsk,
	slugifyTitle,
	sortGrepHits,
	summaryTokenBudget,
	type GrepHit,
	type Metadata,
} from "./pure.ts";

interface Config {
	memDir: string;
	confirmThreshold: boolean;
	/** Context size at which compaction is first offered, ahead of pi's own threshold. */
	askAtTokens: number;
	/** Context growth that must pass after a rejection before offering again. */
	askEveryTokens: number;
	/** Explicit output cap. Unset means no artificial ceiling: the prompt decides how long a record runs. */
	summaryMaxTokens: number | undefined;
	/** Headroom at which asking stops and compaction just happens. Unset scales with reserveTokens. */
	forceHeadroomTokens: number | undefined;
	agentSelfSummary: boolean;
}

interface WrittenRecord {
	recordWritten: boolean;
	indexWritten: boolean;
	path?: string;
	error?: string;
}

type SummaryContext = ExtensionContext | ExtensionCommandContext;
type TriggerReason = "manual" | "threshold" | "overflow" | "manual-smoke" | "schedule";
type DecisionAction = "accepted" | "rejected" | "throttled" | "automatic" | "failed";

const DEFAULT_CONFIG: Config = {
	memDir: "mem",
	confirmThreshold: true,
	askAtTokens: 200_000,
	askEveryTokens: 100_000,
	summaryMaxTokens: undefined,
	forceHeadroomTokens: undefined,
	agentSelfSummary: true,
};

/** Pre-rename names, still read so an existing install keeps working untouched. */
const LEGACY_MEM_DIR = "records";
const LEGACY_CONFIG_NAME = "records.json";
const DECISION_LOG_MAX_BYTES = 2 * 1024 * 1024;
const GREP_TIMEOUT_MS = 15_000;
const INDEX_HINT_ENTRIES = 25;
const INDEX_HEADER = `# Memory Index

> **Retrieval rule:** read the earliest record that covers the period you need, not the latest one. Pi compaction is iterative: each later summary re-summarizes earlier summaries, so early work has passed through more lossy transformations in newer records. The earliest covering record is the least faded snapshot.

Records are appended oldest to newest. Search exact file paths first; before proposing an approach grep \`REJECTED:\`, before establishing a rule grep \`CONVENTION:\`, and for surprising behavior grep \`GOTCHA:\`.

`;

const SUMMARY_PROMPT = `This final message is a synthetic mem-extension instruction, not a requirement from the user. Never quote, summarize, or list this message under Intent or anywhere else in the record. Summarize only the live conversation that precedes it. Do not call tools; return the record directly.\n\nThe conversation may open with an earlier compaction record. Fold its still-relevant conclusions into this one rather than dropping them; those conclusions cannot be recovered from anywhere else.\n\nCreate the compaction record for that live conversation. Return concise conclusions, not copied conversation text. Preserve exact searchable anchors everywhere: full relative paths, function and class names, verbatim error fragments, versioned library names, and exact commands.

Use exactly this structure:

## Intent
The user's goal and how it changed. Every requirement stated by the user MUST be preserved verbatim, never paraphrased. Your own work may be summarized; the user's instructions may not.
## Current Work
What is being done at this exact moment and how far it has progressed.
## Next Step
Planned but not yet executed work.
## Files
Every involved file as a full relative path, with why it matters or what changed.
## Conclusions
One conclusion per line. Every line MUST begin with exactly one of these literal prefixes:
DECISION: what was chosen and why it beat the alternatives
REJECTED: what was tried or considered, abandoned, and why it failed
GOTCHA: behavior that took effort to discover and is not apparent from the code
CONVENTION: a rule established here that later work must follow
Keep each conclusion on one physical line so prefix grep returns a complete readable finding. REJECTED and GOTCHA are especially important because final code cannot reconstruct them.
## Open
Unresolved questions, blockers, and unverified assumptions.

Bad: "tried compilation but it failed".
Good: REJECTED: torch.compile on the custom kernel — fails with "Cannot access member of undefined symbol alloc_workspace" in src/kernel.cu

At the very end emit this machine-readable block, with valid one-line JSON and no markdown fence:
<!-- MEM_META
{"title":"short hyphen-ready title without a heading","summary":"one-sentence causal index description without a conclusion prefix","files":["full/relative/path.ts"]}
MEM_META -->
The metadata files must match the Files section. Do not place any text after the block. Again: this synthetic message itself is excluded from the record.`;

function overlayConfig(base: Config, value: unknown): Config {
	if (!value || typeof value !== "object" || Array.isArray(value)) return base;
	const input = value as Record<string, unknown>;
	return {
		// recordDir is the pre-rename spelling; an existing config keeps working without being edited.
		memDir: firstNonEmptyString(input.memDir, input.recordDir) ?? base.memDir,
		confirmThreshold: typeof input.confirmThreshold === "boolean" ? input.confirmThreshold : base.confirmThreshold,
		askAtTokens:
			typeof input.askAtTokens === "number" && Number.isFinite(input.askAtTokens) && input.askAtTokens > 0 ? input.askAtTokens : base.askAtTokens,
		askEveryTokens:
			typeof input.askEveryTokens === "number" && Number.isFinite(input.askEveryTokens) && input.askEveryTokens > 0
				? input.askEveryTokens
				: base.askEveryTokens,
		summaryMaxTokens:
			typeof input.summaryMaxTokens === "number" && Number.isInteger(input.summaryMaxTokens) && input.summaryMaxTokens > 0
				? input.summaryMaxTokens
				: base.summaryMaxTokens,
		forceHeadroomTokens:
			typeof input.forceHeadroomTokens === "number" && Number.isFinite(input.forceHeadroomTokens) && input.forceHeadroomTokens >= 0
				? input.forceHeadroomTokens
				: base.forceHeadroomTokens,
		agentSelfSummary: typeof input.agentSelfSummary === "boolean" ? input.agentSelfSummary : base.agentSelfSummary,
	};
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) if (typeof value === "string" && value.trim()) return value;
	return undefined;
}

function readConfigFile(path: string): Promise<unknown> {
	return readFile(path, "utf8")
		.then((text) => JSON.parse(text) as unknown)
		.catch(() => undefined);
}

/** Reads mem.json, falling back to the pre-rename records.json in the same directory. */
async function readConfigIn(dir: string): Promise<unknown> {
	return (await readConfigFile(join(dir, "mem.json"))) ?? (await readConfigFile(join(dir, LEGACY_CONFIG_NAME)));
}

/** Defaults < global (~/.pi/agent/mem.json) < project (<cwd>/.pi/mem.json, trusted projects only). */
async function loadConfig(cwd: string, trusted: boolean): Promise<Config> {
	const global = overlayConfig({ ...DEFAULT_CONFIG }, await readConfigIn(getAgentDir()));
	if (!trusted) return global;
	return overlayConfig(global, await readConfigIn(join(cwd, CONFIG_DIR_NAME)));
}

function memRoot(cwd: string, config: Config): string {
	return resolve(cwd, config.memDir);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Moves a pre-rename records/ directory to mem/, once. Only the default layout is touched: an explicit
 * memDir is the user's own choice, and an existing mem/ is never merged into. On failure the records
 * stay where they are and the warning says so, because silently starting a second directory would
 * strand every earlier record.
 */
async function migrateLegacyMemDir(ctx: ExtensionContext, config: Config): Promise<void> {
	if (config.memDir !== DEFAULT_CONFIG.memDir) return;
	const target = memRoot(ctx.cwd, config);
	const legacy = resolve(ctx.cwd, LEGACY_MEM_DIR);
	if (target === legacy || !(await pathExists(legacy))) return;
	const warn = (text: string) => {
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
	};
	if (await pathExists(target)) {
		warn(`Both ${LEGACY_MEM_DIR}/ and ${config.memDir}/ exist; using ${config.memDir}/ and leaving ${LEGACY_MEM_DIR}/ untouched.`);
		return;
	}
	try {
		await rename(legacy, target);
		if (ctx.hasUI) ctx.ui.notify(`Renamed ${LEGACY_MEM_DIR}/ to ${config.memDir}/.`, "info");
	} catch (error) {
		warn(`Could not rename ${LEGACY_MEM_DIR}/ to ${config.memDir}/, so earlier records are not visible: ${errorMessage(error)}`);
	}
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const names = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => names.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/**
 * The span pi is about to discard: context entries up to firstKeptEntryId. Slicing entries rather than
 * taking the whole live context keeps the kept tail out of the summary, and because the span is still a
 * literal prefix of the live context it stays on the cached prompt prefix. An earlier compaction entry at
 * the head of the span supplies the iterative previous summary for free.
 */
function spanMessages(
	ctx: SummaryContext,
	firstKeptEntryId: string | undefined,
	overflowRetry: boolean,
): { messages: Message[]; inputTokens: number } {
	const entries = ctx.sessionManager.buildContextEntries();
	const cut = firstKeptEntryId === undefined ? -1 : entries.findIndex((entry) => entry.id === firstKeptEntryId);
	const span = cut > 0 ? entries.slice(0, cut) : entries;
	const agentMessages = span.flatMap(sessionEntryToContextMessages);
	const messages = convertToLlm(agentMessages);
	if (overflowRetry) {
		const last = messages.at(-1);
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "length")) messages.pop();
	}
	return { messages, inputTokens: agentMessages.reduce((total, message) => total + estimateTokens(message), 0) };
}

async function generateSummary(
	pi: ExtensionAPI,
	ctx: SummaryContext,
	config: Config,
	options: { signal?: AbortSignal; customInstructions?: string; firstKeptEntryId?: string; overflowRetry: boolean },
): Promise<{ body: string; metadata: Metadata; usage: Usage }> {
	if (!ctx.model) throw new Error("No active model is available");
	const instruction = options.customInstructions
		? `${SUMMARY_PROMPT}\n\nAdditional focus requested by the user:\n${options.customInstructions}`
		: SUMMARY_PROMPT;
	const { messages, inputTokens } = spanMessages(ctx, options.firstKeptEntryId, options.overflowRetry);
	if (messages.length === 0) throw new Error("No messages to summarize");
	messages.push({ role: "user", content: instruction, timestamp: Date.now() });
	const maxTokens = summaryTokenBudget(config.summaryMaxTokens, ctx.model.contextWindow, ctx.model.maxTokens, inputTokens);
	const response = await ctx.modelRegistry.complete(
		ctx.model,
		{ systemPrompt: ctx.getSystemPrompt(), messages, tools: activeTools(pi) },
		{
			maxTokens,
			signal: options.signal,
			sessionId: ctx.sessionManager.getSessionId(),
		},
	);
	if (response.stopReason === "length") {
		throw new Error(
			maxTokens === undefined
				? "Summary hit the provider output limit and was truncated"
				: `Summary was truncated at its ${maxTokens}-token budget; raise or remove summaryMaxTokens in mem.json`,
		);
	}
	if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "toolUse") {
		throw new Error(response.errorMessage ?? `Summary stopped with ${response.stopReason}`);
	}
	const raw = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
	if (!raw) throw new Error("Summary response was empty");
	const parsed = parseSummary(raw);
	return { ...parsed, usage: response.usage };
}

async function ensureIndex(root: string): Promise<void> {
	await mkdir(root, { recursive: true });
	try {
		const handle = await open(join(root, "INDEX.md"), "wx");
		await handle.writeFile(INDEX_HEADER, "utf8");
		await handle.close();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function writeRecord(root: string, session: string, body: string, metadata: Metadata, now = new Date()): Promise<WrittenRecord> {
	const date = now.toISOString();
	const year = date.slice(0, 4);
	const month = date.slice(5, 7);
	const day = date.slice(8, 10);
	const dir = join(root, year, month, day);
	try {
		await ensureIndex(root);
		await mkdir(dir, { recursive: true });
		const names = await readdir(dir);
		let sequence = nextSequence(names);
		const slug = slugifyTitle(metadata.title);
		let absolute = "";
		let relativePath = "";
		for (;;) {
			relativePath = `${year}/${month}/${day}/${sequence}_${slug}.md`;
			absolute = join(root, relativePath);
			try {
				const handle = await open(absolute, "wx");
				const document = `${frontmatter({ date, session: session.slice(0, 8), summary: metadata.summary, files: metadata.files })}\n\n${body}\n`;
				await handle.writeFile(document, "utf8");
				await handle.close();
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				sequence += 1;
			}
		}
		const files = metadata.files.length ? metadata.files.join(", ") : "(no files)";
		try {
			await appendFile(join(root, "INDEX.md"), `${date} [${metadata.title}](${relativePath}) — ${metadata.summary} — files: ${files}\n`, "utf8");
			return { recordWritten: true, indexWritten: true, path: absolute };
		} catch (error) {
			return { recordWritten: true, indexWritten: false, path: absolute, error: errorMessage(error) };
		}
	} catch (error) {
		return { recordWritten: false, indexWritten: false, error: errorMessage(error) };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function usageLog(usage: Usage | undefined): Record<string, unknown> | null {
	if (!usage) return null;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
	};
}

async function logDecision(
	root: string,
	data: {
		session: string;
		reason: TriggerReason;
		action: DecisionAction;
		tokens: number;
		percent: number;
		window: number;
		forced?: boolean;
		summarySource: string;
		usage?: Usage;
		recordWritten: boolean;
		indexWritten?: boolean;
		recordPath?: string;
		error?: string;
	},
): Promise<void> {
	try {
		await mkdir(root, { recursive: true });
		const log = join(root, "decisions.jsonl");
		await rotateDecisions(log);
		await appendFile(log, `${JSON.stringify({ time: new Date().toISOString(), ...data, usage: usageLog(data.usage) })}\n`, "utf8");
	} catch {
		// Decision logging must never block compaction.
	}
}

/** Rotation drops at most one session's rejection history, which costs one extra confirm prompt. */
async function rotateDecisions(log: string): Promise<void> {
	try {
		const info = await stat(log);
		if (info.size > DECISION_LOG_MAX_BYTES) await rename(log, `${log}.1`);
	} catch {
		// No log yet, or rotation is not possible; appending still works.
	}
}

/** A rotated-away log costs at most one extra confirm, never a missed compaction. */
async function activeRejection(root: string, session: string): Promise<number | undefined> {
	try {
		return activeRejectionTokens(await readFile(join(root, "decisions.jsonl"), "utf8"), session);
	} catch {
		return undefined;
	}
}

function contextNumbers(ctx: SummaryContext, tokens: number): { tokens: number; percent: number; window: number } {
	const window = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
	return { tokens, percent: window > 0 ? (tokens / window) * 100 : 0, window };
}

async function listRecordFiles(root: string): Promise<string[]> {
	const output: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md") output.push(relative(root, absolute));
		}
	}
	try {
		await walk(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return output;
}

/** Returns undefined when ripgrep is unavailable or rejects the pattern, so the caller can fall back. */
async function grepWithRipgrep(pi: ExtensionAPI, root: string, pattern: string): Promise<GrepHit[] | undefined> {
	try {
		const result = await pi.exec(
			join(getAgentDir(), "bin", "rg"),
			["--no-heading", "--line-number", "--color", "never", "--glob", "*.md", "--glob", "!INDEX.md", "-e", pattern, "."],
			{ cwd: root, timeout: GREP_TIMEOUT_MS },
		);
		if (result.code === 1) return [];
		if (result.code !== 0 || result.killed) return undefined;
		return parseRipgrepHits(result.stdout);
	} catch {
		return undefined;
	}
}

/** Backtracking here can hang on a hostile pattern, so it only runs for patterns ripgrep could not handle. */
async function grepWithRegExp(root: string, pattern: string): Promise<GrepHit[]> {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch (error) {
		throw new Error(`Invalid regular expression: ${errorMessage(error)}`);
	}
	const hits: GrepHit[] = [];
	for (const file of await listRecordFiles(root)) {
		const text = await readFile(join(root, file), "utf8");
		const time = hitTime(file);
		text.split(/\r?\n/).forEach((line, index) => {
			regex.lastIndex = 0;
			if (regex.test(line)) hits.push({ file: file.split(sep).join("/"), line: index + 1, text: line, ...time });
		});
	}
	return hits;
}

async function grepRecords(pi: ExtensionAPI, root: string, pattern: string): Promise<string> {
	if (pattern.length > 500) throw new Error("Regex is limited to 500 characters");
	const hits = (await grepWithRipgrep(pi, root, pattern)) ?? (await grepWithRegExp(root, pattern));
	return sortGrepHits(hits).map((hit) => `${hit.file}:${hit.line}:${hit.text}`).join("\n") || "No matching records.";
}

/** Records are worthless if the agent never learns they exist, so announce the index once per session. */
async function indexHint(root: string): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(join(root, "INDEX.md"), "utf8");
	} catch {
		return undefined;
	}
	const entries = indexEntryLines(text);
	if (entries.length === 0) return undefined;
	const shown = entries.slice(-INDEX_HINT_ENTRIES);
	const omitted = entries.length - shown.length;
	const preamble = omitted > 0 ? `${entries.length} durable work records exist; the ${shown.length} newest are listed below` : `${entries.length} durable work record(s) exist`;
	return `${preamble}. They hold conclusions from earlier compacted work in this project. Use mem (index, grep, read) to retrieve them: read the earliest record covering a period rather than the latest, because iterative compaction makes newer descriptions of early work more lossy. Before proposing an approach grep 'REJECTED:', before establishing a rule grep 'CONVENTION:', and for surprising behavior grep 'GOTCHA:'.\n\n${shown.join("\n")}`;
}

async function safeReadRecord(root: string, path: string): Promise<string> {
	const normalized = path.replace(/^@/, "");
	if (!isSafeRecordPath(root, normalized) || basename(normalized) === "INDEX.md") throw new Error("Unsafe record path");
	const absolute = resolve(root, normalized);
	const rootReal = await realpath(root);
	const stat = await lstat(absolute);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Record path must name a regular file");
	const targetReal = await realpath(absolute);
	const rel = relative(rootReal, targetReal);
	if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(dirname(targetReal), ".") === targetReal) throw new Error("Record path escapes the memory directory");
	return readFile(targetReal, "utf8");
}

export default function memExtension(pi: ExtensionAPI): void {
	let indexAnnounced = false;
	let offering = false;
	let sawRejection = false;

	// pi only fires its own threshold once the window is nearly full, so the cadence has to be driven
	// from here. ctx.compact() aborts whatever is running, which is why this waits for the agent to settle.
	pi.on("agent_settled", async (_event, ctx) => {
		if (offering) return;
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens;
		if (typeof tokens !== "number") return;
		const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
		// Below the entry point with nothing declined yet there is no offer to make, so skip the log read.
		if (!sawRejection && tokens < config.askAtTokens) return;
		const root = memRoot(ctx.cwd, config);
		const session = ctx.sessionManager.getSessionId();
		const rejectedAt = await activeRejection(root, session);
		if (!shouldAsk(tokens, rejectedAt, config.askAtTokens, config.askEveryTokens, false)) return;

		offering = true;
		try {
			const numbers = contextNumbers(ctx, tokens);
			if (config.confirmThreshold && ctx.hasUI) {
				const accepted = await ctx.ui.confirm(
					"Compact context and write a record?",
					`${tokens.toLocaleString()} tokens (${numbers.percent.toFixed(1)}% of the context window)`,
				);
				if (!accepted) {
					sawRejection = true;
					await logDecision(root, { session, reason: "schedule", action: "rejected", ...numbers, summarySource: "none", recordWritten: false });
					return;
				}
			}
			ctx.compact();
		} finally {
			offering = false;
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (indexAnnounced) return;
		indexAnnounced = true;
		const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
		// Runs before any other handler can touch the directory, since the agent must start before it compacts.
		await migrateLegacyMemDir(ctx, config);
		const hint = await indexHint(memRoot(ctx.cwd, config));
		if (!hint) return;
		return { message: { customType: "mem-index", content: hint, display: false } };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const root = memRoot(ctx.cwd, config);
		const session = ctx.sessionManager.getSessionId();
		const numbers = contextNumbers(ctx, event.preparation.tokensBefore);

		// Deferring is only safe while headroom remains: every cancel below lets the context keep growing,
		// and the next request is what would overflow. Past the floor the answer stops being the user's.
		const headroom = numbers.window - numbers.tokens;
		const floor = forceHeadroom(event.preparation.settings.reserveTokens, config.forceHeadroomTokens);
		const forced = isForcedCompaction(numbers.window, numbers.tokens, floor);

		if (event.reason === "threshold" && !forced) {
			const rejectedAt = await activeRejection(root, session);
			if (!shouldAsk(numbers.tokens, rejectedAt, config.askAtTokens, config.askEveryTokens, true)) {
				await logDecision(root, { session, reason: event.reason, action: "throttled", ...numbers, forced, summarySource: "none", recordWritten: false });
				return { cancel: true };
			}
			if (config.confirmThreshold && ctx.hasUI) {
				const accepted = await ctx.ui.confirm(
					"Compact context and write a record?",
					`${numbers.tokens.toLocaleString()} tokens (${numbers.percent.toFixed(1)}% of the context window), ${headroom.toLocaleString()} left`,
				);
				if (!accepted) {
					sawRejection = true;
					await logDecision(root, { session, reason: event.reason, action: "rejected", ...numbers, forced, summarySource: "none", recordWritten: false });
					return { cancel: true };
				}
			}
		}

		if (event.reason === "threshold" && forced && config.confirmThreshold) {
			const detail = numbers.window > 0 ? `${headroom.toLocaleString()} tokens of headroom left` : "context window size is unknown";
			ctx.ui.notify(`Compacting without asking: ${detail}.`, "warning");
		}

		const action: DecisionAction =
			event.reason === "overflow" || forced || (event.reason === "threshold" && (!config.confirmThreshold || !ctx.hasUI)) ? "automatic" : "accepted";
		if (!config.agentSelfSummary) {
			await logDecision(root, { session, reason: event.reason, action, ...numbers, forced, summarySource: "pi-default", recordWritten: false });
			return;
		}

		try {
			ctx.ui.notify("Generating cached-prefix compaction record…", "info");
			const generated = await generateSummary(pi, ctx, config, {
				signal: event.signal,
				customInstructions: event.customInstructions,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				overflowRetry: event.reason === "overflow" && event.willRetry,
			});
			const written = await writeRecord(root, session, generated.body, generated.metadata);
			if (!written.recordWritten) ctx.ui.notify(`Compaction record write failed: ${written.error}`, "warning");
			else if (!written.indexWritten) ctx.ui.notify(`Record written but INDEX.md append failed: ${written.error}`, "warning");
			else ctx.ui.notify(`Record written: ${written.path}`, "info");
			await logDecision(root, {
				session,
				reason: event.reason,
				action: written.recordWritten ? action : "failed",
				...numbers,
				forced,
				summarySource: "agent-live-context",
				usage: generated.usage,
				recordWritten: written.recordWritten,
				indexWritten: written.indexWritten,
				recordPath: written.path,
				error: written.error,
			});
			return {
				compaction: {
					summary: generated.body,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: generated.usage,
					details: { recordPath: written.path, files: generated.metadata.files },
				},
			};
		} catch (error) {
			const message = errorMessage(error);
			ctx.ui.notify(`Record summary failed; Pi will use default compaction: ${message}`, "error");
			await logDecision(root, {
				session,
				reason: event.reason,
				action: "failed",
				...numbers,
				forced,
				summarySource: "agent-live-context-failed; pi-default-fallback",
				recordWritten: false,
				error: message,
			});
			return;
		}
	});

	pi.registerCommand("mem-smoke", {
		description: "Generate and write a record without compacting context",
		handler: async (_args, ctx) => {
			const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const root = memRoot(ctx.cwd, config);
			const session = ctx.sessionManager.getSessionId();
			const usage = ctx.getContextUsage();
			const numbers = contextNumbers(ctx, usage?.tokens ?? 0);
			try {
				const generated = await generateSummary(pi, ctx, config, {
					customInstructions: "Smoke test: describe the current work faithfully.",
					overflowRetry: false,
				});
				const written = await writeRecord(root, session, generated.body, generated.metadata);
				await logDecision(root, {
					session,
					reason: "manual-smoke",
					action: written.recordWritten ? "accepted" : "failed",
					...numbers,
					summarySource: "agent-live-context",
					usage: generated.usage,
					recordWritten: written.recordWritten,
					indexWritten: written.indexWritten,
					recordPath: written.path,
					error: written.error,
				});
				if (!written.recordWritten) throw new Error(written.error ?? "record write failed");
				ctx.ui.notify(`Smoke record written: ${written.path}`, "info");
			} catch (error) {
				const message = errorMessage(error);
				await logDecision(root, { session, reason: "manual-smoke", action: "failed", ...numbers, summarySource: "agent-live-context", recordWritten: false, error: message });
				ctx.ui.notify(`Memory smoke test failed: ${message}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "mem",
		label: "Memory",
		description:
			"Search this project's durable memory: records written from earlier compacted conversations. Actions: index reads INDEX.md; grep matches a regex against every record and returns matches oldest-first (ripgrep syntax, falling back to JavaScript regex for patterns ripgrep rejects, such as lookaround); read reads one record path relative to the memory directory. Read the earliest record covering a period, not the latest, because iterative compaction makes newer descriptions of early work more lossy. Before proposing an approach grep 'REJECTED:', before establishing a rule grep 'CONVENTION:', and for surprising behavior grep 'GOTCHA:'.",
		parameters: Type.Object({
			action: StringEnum(["index", "grep", "read"] as const),
			query: Type.Optional(Type.String({ description: "JavaScript regular expression for grep" })),
			path: Type.Optional(Type.String({ description: "Record path relative to the memory directory for read" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const root = memRoot(ctx.cwd, config);
			let text: string;
			if (params.action === "index") {
				try {
					text = await readFile(join(root, "INDEX.md"), "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					text = INDEX_HEADER;
				}
			} else if (params.action === "grep") {
				if (!params.query) throw new Error("query is required for grep");
				text = await grepRecords(pi, root, params.query);
			} else {
				if (!params.path) throw new Error("path is required for read");
				text = await safeReadRecord(root, params.path);
			}
			const truncated = truncateHead(text);
			return {
				content: [{ type: "text", text: truncated.content + (truncated.truncated ? "\n[Memory output truncated at 50KB/2000 lines.]" : "") }],
				details: { action: params.action, truncated: truncated.truncated },
			};
		},
	});
}
