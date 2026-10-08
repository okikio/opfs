#!/usr/bin/env bash
#MISE description="Check the storage expansion planning records"
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e planning/storage/research/validate.ts ]] || { echo "planning/storage/research/validate.ts does not exist at this revision; nothing to run."; exit 0; }
exec node planning/storage/research/validate.ts
