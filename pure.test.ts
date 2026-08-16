import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
	deriveSummary,
	deriveTitle,
	activeRejectionTokens,
	forceHeadroom,
	frontmatter,
	indexEntryLines,
	isForcedCompaction,
	isSafeRecordPath,
	nextSequence,
	parseRipgrepHits,
	parseSummary,
	shouldAsk,
	slugifyTitle,
	sortGrepHits,
	summaryTokenBudget,
} from "./pure.ts";

test("title and summary derivation skip Markdown headings", () => {
	const body = "## Intent\n\n## Current Work\n\nImplemented src/cache.ts safely.\n";
	assert.equal(deriveTitle(body), "Implemented src/cache.ts safely.");
	assert.equal(slugifyTitle(deriveTitle(body)), "implemented-src-cache-ts-safely");
});

test("summary derivation prefers a non-conclusion line", () => {
	const body = "## Conclusions\nREJECTED: old API — failed\nGOTCHA: hidden behavior\n\n## Open\nVerify tests tomorrow.";
	assert.equal(deriveSummary(body), "Verify tests tomorrow.");
});

test("sequence chooses the smallest free positive integer", () => {
	assert.equal(nextSequence(["1_first.md", "3_third.md", "not-a-record.md"]), 2);
	assert.equal(nextSequence(["2_second.md"]), 1);
});

test("frontmatter YAML safely round-trips colons and quotes", () => {
	const summary = 'Fix parser: preserve "quoted: value" and backslash \\';
	const rendered = frontmatter({ date: "2026-08-15T12:00:00.000Z", session: "12345678", summary, files: ['src/a:"b".ts'] });
	const parsed = parseYaml(rendered.slice(4, -3)) as { summary: string; files: string[] };
	assert.equal(parsed.summary, summary);
	assert.deepEqual(parsed.files, ['src/a:"b".ts']);
});

test("grep hits sort oldest to newest, then by sequence and line", () => {
	const sorted = sortGrepHits([
		{ file: "2026/08/16/1_b.md", date: "2026-08-16", sequence: 1, line: 2, text: "b" },
		{ file: "2026/08/15/2_a.md", date: "2026-08-15", sequence: 2, line: 4, text: "a2" },
		{ file: "2026/08/15/1_a.md", date: "2026-08-15", sequence: 1, line: 8, text: "a1" },
	]);
	assert.deepEqual(sorted.map((hit) => hit.text), ["a1", "a2", "b"]);
});

test("the force floor scales with the reserve, not with the window", () => {
	assert.equal(forceHeadroom(16_384, undefined), 8_192);
	assert.equal(forceHeadroom(65_536, undefined), 32_768);
	assert.equal(forceHeadroom(16_384, 30_000), 30_000, "an explicit floor wins");
	assert.equal(forceHeadroom(0, undefined), 0);
});

test("a rejection stays active until a compaction clears it", () => {
	const reject = '{"session":"s1","reason":"threshold","action":"rejected","tokens":255616}';
	const throttle = '{"session":"s1","reason":"threshold","action":"throttled","tokens":258000}';
	const compact = '{"session":"s1","reason":"threshold","action":"automatic","tokens":263808}';
	const smoke = '{"session":"s1","reason":"manual-smoke","action":"accepted","tokens":1000}';
	assert.equal(activeRejectionTokens(reject, "s1"), 255_616);
	assert.equal(activeRejectionTokens(`${reject}\n${throttle}\n${throttle}`, "s1"), 255_616, "throttles are the reused answer, not a new one");
	assert.equal(activeRejectionTokens(`${reject}\n${throttle}\n${compact}`, "s1"), undefined, "a completed compaction starts a fresh cycle");
	assert.equal(activeRejectionTokens(`${reject}\n${smoke}`, "s1"), 255_616, "a smoke test compacts nothing");
	assert.equal(activeRejectionTokens(reject, "s2"), undefined, "other sessions do not leak");
	assert.equal(activeRejectionTokens("", "s1"), undefined);
});

test("the offer cadence is absolute and does not nag after a rejection", () => {
	const ask = (tokens: number, rejectedAt: number | undefined, atThreshold = false) =>
		shouldAsk(tokens, rejectedAt, 200_000, 100_000, atThreshold);
	assert.equal(ask(199_999, undefined), false);
	assert.equal(ask(200_000, undefined), true, "first offer at the entry point");
	assert.equal(ask(299_999, 200_000), false, "declined at 200k stays quiet below 300k");
	assert.equal(ask(300_000, 200_000), true, "one interval later it offers again");

	// pi's threshold is late enough to justify an ask even on a window too small to reach 200k.
	assert.equal(ask(112_000, undefined, true), true);
	assert.equal(ask(255_616, 200_000, true), false, "the threshold still respects the interval");
});

test("summary budget stays uncapped unless the provider default would not fit", () => {
	// gpt-5.6-sol: 272000 window, 128000 max output.
	assert.equal(summaryTokenBudget(undefined, 272_000, 128_000, 10_000), undefined);
	assert.equal(summaryTokenBudget(undefined, 272_000, 128_000, 220_000), 49_952);
	assert.equal(summaryTokenBudget(undefined, 272_000, 128_000, 271_000), 2_048);
	assert.equal(summaryTokenBudget(undefined, 0, 128_000, 10_000), undefined);
	assert.equal(summaryTokenBudget(8_192, 272_000, 128_000, 10_000), 8_192);
});

test("compaction is forced once headroom reaches the floor", () => {
	// gpt-5.6-sol: 272000 window, pi's threshold fires at 16384 headroom, floor at 8192.
	assert.equal(isForcedCompaction(272_000, 255_616, 8_192), false);
	assert.equal(isForcedCompaction(272_000, 263_808, 8_192), true);
	assert.equal(isForcedCompaction(272_000, 271_000, 8_192), true);
	assert.equal(isForcedCompaction(0, 1_000, 8_192), true);
});

test("ripgrep output parses into dated hits and keeps colons in matched text", () => {
	const hits = parseRipgrepHits("./2026/08/15/2_a.md:7:REJECTED: torch.compile — fails\n./2026/08/16/1_b.md:3:GOTCHA: x\n\n");
	assert.deepEqual(hits, [
		{ file: "2026/08/15/2_a.md", line: 7, text: "REJECTED: torch.compile — fails", date: "2026-08-15", sequence: 2 },
		{ file: "2026/08/16/1_b.md", line: 3, text: "GOTCHA: x", date: "2026-08-16", sequence: 1 },
	]);
});

test("index entry lines exclude the header prose", () => {
	const index = "# Work Record Index\n\n> Retrieval rule: read the earliest record.\n\nRecords are appended oldest to newest.\n\n2026-08-15T12:00:00.000Z [a](2026/08/15/1_a.md) — s — files: x\n";
	assert.deepEqual(indexEntryLines(index), ["2026-08-15T12:00:00.000Z [a](2026/08/15/1_a.md) — s — files: x"]);
});

test("the metadata block is read and stripped from the body", () => {
	const raw = '## Intent\nDid the thing.\n\n<!-- MEM_META\n{"title":"t","summary":"s","files":["a.ts","a.ts"," "]}\nMEM_META -->';
	const parsed = parseSummary(raw);
	assert.equal(parsed.body, "## Intent\nDid the thing.");
	assert.deepEqual(parsed.metadata, { title: "t", summary: "s", files: ["a.ts"] }, "duplicate and blank files are dropped");
});

test("a record without a usable metadata block falls back to derivation", () => {
	assert.deepEqual(parseSummary("## Intent\nDid the thing.").metadata, { title: "Did the thing.", summary: "Did the thing.", files: [] });
	// A corrupt JSON payload must not lose the body that surrounds it.
	const broken = parseSummary("## Intent\nDid the thing.\n\n<!-- MEM_META\n{not json\nMEM_META -->");
	assert.equal(broken.body, "## Intent\nDid the thing.");
	assert.equal(broken.metadata.title, "Did the thing.");
	assert.throws(() => parseSummary("   "), /Summary body was empty/);
});

test("path traversal and absolute paths are rejected", () => {
	const root = "/tmp/project/mem";
	assert.equal(isSafeRecordPath(root, "2026/08/15/1_ok.md"), true);
	assert.equal(isSafeRecordPath(root, "../secrets.md"), false);
	assert.equal(isSafeRecordPath(root, "/etc/passwd.md"), false);
	assert.equal(isSafeRecordPath(root, "2026/08/15/not-markdown.txt"), false);
});
