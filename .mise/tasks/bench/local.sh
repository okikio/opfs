#!/usr/bin/env bash
#MISE description="Run the benchmarks that need no container or browser; optional files and --shard"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/bench/local.ts "$@"
