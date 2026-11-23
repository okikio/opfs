#!/usr/bin/env bash
#MISE description="Run the agent source-retention regressions (GNU tar, 192 MiB heap)"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec deno test --no-check --node-modules-dir=manual --frozen --v8-flags=--max-old-space-size=192 \
  --allow-read --allow-write --allow-run=/usr/bin/tar --allow-sys=statfs --allow-env=TMPDIR,TMP,TEMP \
  .agents/validation/snapshot.test.ts
