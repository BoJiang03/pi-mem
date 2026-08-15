# records — durable work records for pi

A pi extension that turns context compaction into a durable, greppable artifact. Instead of letting a
summary vanish into the session, every compaction writes a Markdown record under the project's
`records/YYYY/MM/DD/` and appends a line to `records/INDEX.md`, which the agent is told about at the
start of each run.

It also drives *when* compaction happens, because pi's own trigger fires only once the window is
nearly full:

- **Ask at 200k tokens**, ahead of pi's threshold, while there is still room for a good summary.
- **Ask again every 100k** after a decline — never more often, so a "no" is respected.
- **Compact without asking** once headroom drops to half of pi's `reserveTokens`.

The cadence is absolute because it tracks how much work has piled up, which is a property of the
conversation. The force floor derives from `reserveTokens` because it is pure window pressure. That
split is deliberate: a 1M-token model should still be asked at 200k.

## Install on a new machine

```sh
git clone <this-repo> ~/.pi/agent/extensions/records
~/.pi/agent/extensions/records/install.sh
```

Pi discovers `<agent-dir>/extensions/*/index.ts` automatically — there is no build step and no
registration. If `PI_CODING_AGENT_DIR` is set, clone under that directory instead of `~/.pi/agent`.

Add `--dev` to also `npm install` the dev dependencies, which are needed only for
`npm run typecheck` and `npm test`.

## What is and is not portable

The extension has **zero runtime dependencies**. `index.ts` imports only pi's own packages (injected
by the host at load time), node builtins, and `./pure.ts`. Ripgrep comes from pi's bundled
`<agent-dir>/bin/rg`, with a JavaScript regex fallback for patterns ripgrep rejects. `yaml` is a test
dependency; the frontmatter writer emits YAML by hand.

So `index.ts` and `pure.ts` are the whole payload. Everything else in this repo is either tests or
setup.

Two things do not travel in the clone:

- `tsconfig.json` — its `paths` must point at wherever pi is installed on this machine, so
  `install.sh` generates it from `tsconfig.template.json`. Re-run `install.sh` after moving or
  reinstalling pi.
- `records.json` — configuration lives in the agent directory, not here. `install.sh` seeds it from
  `records.example.json` and never overwrites an existing one.

## Configuration

Defaults are overlaid in three layers: built-in defaults, then `<agent-dir>/records.json`, then
`<cwd>/.pi/records.json` for trusted projects only.

| Key | Default | Meaning |
| --- | --- | --- |
| `recordDir` | `records` | Record directory, resolved against the project cwd |
| `confirmThreshold` | `true` | Ask before compacting; `false` compacts silently |
| `askAtTokens` | `200000` | Context size at which compaction is first offered |
| `askEveryTokens` | `100000` | Context growth required after a decline before offering again |
| `summaryMaxTokens` | unset | Output cap. Unset means the prompt decides the length |
| `forceHeadroomTokens` | unset | Headroom at which asking stops. Unset means half of `reserveTokens` |
| `agentSelfSummary` | `true` | Let the agent write its own record rather than using pi's summary |

The shipped `records.example.json` writes `askAtTokens` and `askEveryTokens` explicitly even though
they match the defaults, so that changing a default later cannot silently change an existing policy.

Records are per-project, under each project's own cwd — nothing needs migrating between machines.

## Related pi settings

`compaction.keepRecentTokens` in `<agent-dir>/settings.json` controls how much recent conversation
pi keeps verbatim, and `compaction.reserveTokens` (default 16384, flat regardless of window size)
sets pi's own trigger point and therefore this extension's force floor. Neither is managed here.

## Development

```sh
./install.sh --dev
npm run typecheck
npm test
```

Logic worth testing lives in `pure.ts` as pure functions, with `pure.test.ts` alongside it.
`index.ts` holds the I/O and the event handlers.
