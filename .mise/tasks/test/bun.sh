#!/usr/bin/env bash
#MISE description="Run discovered tests on Bun; optional files, --family, --shard"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/testing/run.ts bun "$@"
