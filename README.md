# pi-mem — durable memory across compaction for pi

An unofficial extension for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
that turns context compaction into a durable, greppable artifact. Instead of letting a summary vanish
into the session, every compaction writes a Markdown record under the project's `mem/YYYY/MM/DD/`
and appends a line to `mem/INDEX.md`, which the agent is told about at the start of each run. The
agent can then grep its own past work rather than rediscovering it.

> The store is `mem/`; one entry in it is a *record*. The agent reaches it through a tool named `mem`.

It also drives *when* compaction happens, because pi's own trigger fires only once the window is
nearly full:

- **Ask at 200k tokens**, ahead of pi's threshold, while there is still room for a good summary.
- **Ask again every 100k** after a decline — never more often, so a "no" is respected.
- **Compact without asking** once headroom drops to half of pi's `reserveTokens`.

The cadence is absolute because it tracks how much work has piled up, which is a property of the
conversation. The force floor derives from `reserveTokens` because it is pure window pressure. That
split is deliberate: a 1M-token model should still be asked at 200k.

## Requirements

Pi `0.84.2`. The extension uses host APIs that carry no stability guarantee — the
`session_before_compact` and `agent_settled` events, `ctx.compact()`, and `ctx.getContextUsage()` —
so a pi upgrade can break it. If it stops loading after an upgrade, that is the first place to look.

## Install

```sh
git clone https://github.com/BoJiang03/pi-mem.git ~/.pi/agent/extensions/pi-mem
~/.pi/agent/extensions/pi-mem/install.sh
```

Pi discovers `<agent-dir>/extensions/*/index.ts` automatically — there is no build step and no
registration, and the directory name is arbitrary. If `PI_CODING_AGENT_DIR` is set, clone under that
directory instead of `~/.pi/agent`.

Add `--dev` to also `npm install` the dev dependencies, which are needed only for
`npm run typecheck` and `npm test`.

Re-run `install.sh` after upgrading or relocating pi; it is idempotent and never overwrites an
existing config.

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
- `mem.json` — configuration lives in the agent directory, not here. `install.sh` seeds it from
  `mem.example.json` and never overwrites an existing one.

## Configuration

Defaults are overlaid in three layers: built-in defaults, then `<agent-dir>/mem.json`, then
`<cwd>/.pi/mem.json` for trusted projects only.

| Key | Default | Meaning |
| --- | --- | --- |
| `memDir` | `mem` | Memory directory, resolved against the project cwd |
| `confirmThreshold` | `true` | Ask before compacting; `false` compacts silently |
| `askAtTokens` | `200000` | Context size at which compaction is first offered |
| `askEveryTokens` | `100000` | Context growth required after a decline before offering again |
| `summaryMaxTokens` | unset | Output cap. Unset means the prompt decides the length |
| `forceHeadroomTokens` | unset | Headroom at which asking stops. Unset means half of `reserveTokens` |
| `agentSelfSummary` | `true` | Let the agent write its own record rather than using pi's summary |

The shipped `mem.example.json` writes `askAtTokens` and `askEveryTokens` explicitly even though
they match the defaults, so that changing a default later cannot silently change an existing policy.

Memory is per-project, under each project's own cwd — nothing needs migrating between machines.

## Related pi settings

`compaction.keepRecentTokens` in `<agent-dir>/settings.json` controls how much recent conversation
pi keeps verbatim, and `compaction.reserveTokens` (default 16384, flat regardless of window size)
sets pi's own trigger point and therefore this extension's force floor. Neither is managed here.

Pi passes `reserveTokens` to the compaction event but exposes it nowhere else, so the scheduler reads
it back out of `settings.json` directly. That is the one place this extension depends on pi's
on-disk settings format rather than its API.

## Development

```sh
./install.sh --dev
npm run typecheck
npm test
```

Logic worth testing lives in `pure.ts` as pure functions, with `pure.test.ts` alongside it.
`index.ts` holds the I/O and the event handlers.

`tsconfig.json` is generated and gitignored because its `paths` must point at the local pi install;
edit `tsconfig.template.json` instead.

## License

MIT — see [LICENSE](LICENSE).
