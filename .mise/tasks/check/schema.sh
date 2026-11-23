#!/usr/bin/env bash
#MISE description="Check that generated JSON Schemas match their Zod sources"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e tools/schema/schema.ts ]] || { echo "tools/schema/schema.ts does not exist at this revision; nothing to run."; exit 0; }
exec deno run --frozen --allow-read tools/schema/schema.ts --check
