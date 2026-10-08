#!/usr/bin/env bash
#MISE description="Type-check every complete Markdown example"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e tools/workspace/examples.ts ]] || { echo "tools/workspace/examples.ts does not exist at this revision; nothing to run."; exit 0; }
exec node tools/workspace/examples.ts --check
