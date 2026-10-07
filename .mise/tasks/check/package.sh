#!/usr/bin/env bash
#MISE description="Build the npm package and test it from a clean consumer"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e tools/npm/pack.ts ]] || { echo "tools/npm/pack.ts does not exist at this revision; nothing to run."; exit 0; }
exec deno run --frozen -A tools/npm/pack.ts --verify
