#!/usr/bin/env bash
#MISE description="Build the npm package directory and tarball under .tmp/npm"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e tools/npm/pack.ts ]] || { echo "tools/npm/pack.ts does not exist at this revision; nothing to run."; exit 0; }
exec deno run --frozen -A tools/npm/pack.ts "$@"
