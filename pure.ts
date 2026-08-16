import { isAbsolute, relative, resolve, sep } from "node:path";

export const CONCLUSION_PREFIX = /^(?:DECISION|REJECTED|GOTCHA|CONVENTION):\s*/;

export interface GrepHit {
	file: string;
	line: number;
	text: string;
	date: string;
	sequence: number;
}

export function contentLines(markdown: string): string[] {
	return markdown
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^#{1,6}(?:\s|$)/.test(line) && !/^<!--/.test(line));
}

export function deriveSummary(markdown: string): string {
	const lines = contentLines(markdown);
	const preferred = lines.find((line) => !CONCLUSION_PREFIX.test(line) && !/^[-*+]\s*$/.test(line));
	return stripListMarker(preferred ?? lines[0] ?? "Work record").slice(0, 240);
}

export function deriveTitle(markdown: string): string {
	return deriveSummary(markdown).slice(0, 80);
}

function stripListMarker(line: string): string {
	return line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
}

export function slugifyTitle(title: string): string {
	const slug = title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s_]+/gu, "-")
		.replace(/[^\p{Letter}\p{Number}-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 72)
		.replace(/-$/g, "");
	return slug || "work-record";
}

export interface Metadata {
	title: string;
	summary: string;
	files: string[];
}

/** The trailing metadata block a record ends with. */
const META_RE = /\n?<!--\s*MEM_META\s*\n([\s\S]*?)\nMEM_META\s*-->\s*$/;

/** Splits a model-written record into its prose body and its trailing metadata block. */
export function parseSummary(raw: string): { body: string; metadata: Metadata } {
	const match = META_RE.exec(raw);
	const body = (match ? raw.slice(0, match.index) : raw).trim();
	if (!body) throw new Error("Summary body was empty");
	let value: unknown;
	if (match) {
		try {
			value = JSON.parse(match[1].trim());
		} catch {
			value = undefined;
		}
	}
	const meta = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : deriveTitle(body);
	const summary = typeof meta.summary === "string" && meta.summary.trim() ? meta.summary.trim() : deriveSummary(body);
	const files = Array.isArray(meta.files)
		? [...new Set(meta.files.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
		: [];
	return { body, metadata: { title, summary, files } };
}

export function nextSequence(names: readonly string[]): number {
	const occupied = new Set(
		names.map((name) => /^(\d+)_/.exec(name)?.[1]).filter((value): value is string => value !== undefined).map(Number),
	);
	let candidate = 1;
	while (occupied.has(candidate)) candidate += 1;
	return candidate;
}

/** JSON strings are valid YAML double-quoted scalars and safely preserve colons and quotes. */
export function yamlString(value: string): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function frontmatter(input: {
	date: string;
	session: string;
	summary: string;
	files: readonly string[];
}): string {
	const fileLines = input.files.length === 0 ? "files: []" : `files:\n${input.files.map((file) => `  - ${yamlString(file)}`).join("\n")}`;
	return `---\ndate: ${yamlString(input.date)}\nsession: ${yamlString(input.session)}\nsummary: ${yamlString(input.summary)}\n${fileLines}\n---`;
}

export function isSafeRecordPath(root: string, candidate: string): boolean {
	if (!candidate || isAbsolute(candidate) || candidate.includes("\0")) return false;
	const target = resolve(root, candidate);
	const rel = relative(resolve(root), target);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && target.toLowerCase().endsWith(".md");
}

export function sortGrepHits(hits: readonly GrepHit[]): GrepHit[] {
	return [...hits].sort(
		(a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence || a.file.localeCompare(b.file) || a.line - b.line,
	);
}

/**
 * Token count at this session's still-standing rejection, or undefined when none stands. A rejection
 * stays active until a compaction actually clears it: throttled entries are the reused answer so they
 * clear nothing, and a smoke test compacts nothing so it clears nothing either.
 */
export function activeRejectionTokens(logText: string, session: string): number | undefined {
	for (const line of logText.trim().split("\n").reverse()) {
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (value.session !== session || value.reason === "manual-smoke" || value.action === "throttled") continue;
		if (value.action !== "rejected") return undefined;
		return typeof value.tokens === "number" ? value.tokens : undefined;
	}
	return undefined;
}

/**
 * The cadence is deliberately absolute: it tracks how much work has piled up, which is a property of
 * the conversation rather than of the window. The force floor is the opposite — pure window pressure —
 * so it scales with the reserve pi keeps, which pi itself does not scale with the window.
 */
export function forceHeadroom(reserveTokens: number, override: number | undefined): number {
	return override ?? Math.floor(Math.max(reserveTokens, 0) / 2);
}

/** Pi's own default when settings.json says nothing (settings-manager.js: reserveTokens ?? 16384). */
export const PI_DEFAULT_RESERVE_TOKENS = 16384;

/**
 * Pi hands the reserve to the compaction event but exposes it nowhere else, so the scheduler has to
 * read it back out of pi's settings file to know where the force floor sits.
 */
export function piReserveTokens(settings: unknown): number {
	const compaction = (settings as { compaction?: unknown } | null | undefined)?.compaction;
	const value = (compaction as { reserveTokens?: unknown } | null | undefined)?.reserveTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : PI_DEFAULT_RESERVE_TOKENS;
}

/**
 * Before any rejection the first ask waits for the cadence entry point, except at pi's own threshold,
 * which is late enough to be worth an ask on any window — including one too small to ever reach the
 * entry point. After a rejection both paths wait a full interval so neither can nag.
 */
export function shouldAsk(
	tokens: number,
	rejectedAt: number | undefined,
	askAtTokens: number,
	askEveryTokens: number,
	atThreshold: boolean,
): boolean {
	if (rejectedAt !== undefined) return tokens >= rejectedAt + askEveryTokens;
	return atThreshold || tokens >= askAtTokens;
}

/** Slack for the instruction message and for estimator error. */
export const SUMMARY_INPUT_MARGIN = 2048;
export const SUMMARY_MIN_TOKENS = 2048;

/**
 * Length is governed by the prompt, not by an arbitrary ceiling, so the default is no explicit cap
 * (undefined) and the provider applies its own. The only hazard worth guarding is a provider default
 * so large that input + output cannot fit the window, which would make the request itself invalid.
 */
export function summaryTokenBudget(
	explicit: number | undefined,
	window: number,
	modelMax: number,
	inputTokens: number,
): number | undefined {
	if (explicit !== undefined) return explicit;
	if (window <= 0 || modelMax <= 0) return undefined;
	const available = window - inputTokens - SUMMARY_INPUT_MARGIN;
	return available >= modelMax ? undefined : Math.max(available, SUMMARY_MIN_TOKENS);
}

/** An unknown window (0) counts as forced: never gamble the session on a headroom we cannot measure. */
export function isForcedCompaction(window: number, tokens: number, forceHeadroomTokens: number): boolean {
	if (window <= 0) return true;
	return window - tokens <= forceHeadroomTokens;
}

export function hitTime(path: string): { date: string; sequence: number } {
	const normalized = path.split(sep).join("/");
	const match = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d+)_/.exec(normalized);
	return match ? { date: `${match[1]}-${match[2]}-${match[3]}`, sequence: Number(match[4]) } : { date: "9999-99-99", sequence: 0 };
}

/** Ripgrep emits `path:line:text`; record paths never contain a colon because slugifyTitle strips them. */
export function parseRipgrepHits(stdout: string): GrepHit[] {
	const hits: GrepHit[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^(.+?):(\d+):([\s\S]*)$/.exec(line);
		if (!match) continue;
		const file = match[1].replace(/^\.[/\\]/, "").split("\\").join("/");
		hits.push({ file, line: Number(match[2]), text: match[3], ...hitTime(file) });
	}
	return hits;
}

export function indexEntryLines(markdown: string): string[] {
	return markdown.split(/\r?\n/).filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line));
}
