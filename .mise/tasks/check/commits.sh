#!/usr/bin/env bash
#MISE description="Check Conventional Commit subjects between BASE_SHA and HEAD_SHA"
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e tools/workspace/commits.ts ]] || { echo "tools/workspace/commits.ts does not exist at this revision; nothing to run."; exit 0; }
exec deno run --allow-env=BASE_SHA,HEAD_SHA --allow-run tools/workspace/commits.ts
