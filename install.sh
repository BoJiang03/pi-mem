#!/usr/bin/env sh
# Sets up the records extension after a clone. Idempotent: safe to re-run after a pi upgrade.
#
# The extension itself needs no installation — pi discovers <agent-dir>/extensions/*/index.ts and
# injects its own packages at runtime. This script only produces the two things a clone cannot
# carry: a tsconfig.json pointing at wherever pi happens to live here, and a starting config.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}

case "$here" in
"$agent_dir"/extensions/*) ;;
*) echo "warning: pi only loads extensions under $agent_dir/extensions/<name>/index.ts, not $here" >&2 ;;
esac

# Prefer the npm global root; fall back to following the pi symlink for other installers.
pkg="$(npm root -g 2>/dev/null || true)/@earendil-works/pi-coding-agent"
if [ ! -f "$pkg/dist/index.d.ts" ]; then
	pi_bin=$(command -v pi || true)
	[ -n "$pi_bin" ] || { echo "error: pi is not on PATH; install @earendil-works/pi-coding-agent first" >&2; exit 1; }
	pkg=$(cd "$(dirname "$(readlink -f "$pi_bin")")/.." && pwd)
fi
[ -f "$pkg/dist/index.d.ts" ] || { echo "error: cannot locate the pi package (looked in $pkg)" >&2; exit 1; }

sed "s#__PI_PKG__#$pkg#g" "$here/tsconfig.template.json" > "$here/tsconfig.json"
echo "wrote tsconfig.json -> $pkg"

if [ -f "$agent_dir/records.json" ]; then
	echo "kept existing $agent_dir/records.json"
else
	mkdir -p "$agent_dir"
	cp "$here/records.example.json" "$agent_dir/records.json"
	echo "wrote $agent_dir/records.json"
fi

# Dev dependencies are only needed to run `npm run typecheck` and `npm test`.
if [ "${1:-}" = "--dev" ]; then
	(cd "$here" && npm install)
fi

echo "done — start pi, or /reload if it is already running"
