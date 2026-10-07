#!/usr/bin/env bash
#MISE description="Run the agent source-retention regressions (GNU tar, 192 MiB heap)"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e .agents/validation/snapshot.test.ts ]] || { echo ".agents/validation does not exist at this revision; nothing to run."; exit 0; }
exec deno test --no-check --node-modules-dir=manual --frozen --v8-flags=--max-old-space-size=192 \
  --allow-read --allow-write --allow-run=/usr/bin/tar --allow-sys=statfs --allow-env=TMPDIR,TMP,TEMP \
  .agents/validation/snapshot.test.ts
