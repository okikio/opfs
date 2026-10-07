#!/usr/bin/env bash
#MISE description="Benchmark provider clients against Testcontainers baselines"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e bench/providers.ts ]] || { echo "bench/providers.ts does not exist at this revision; nothing to run."; exit 0; }
exec node --expose-gc bench/providers.ts "$@"
