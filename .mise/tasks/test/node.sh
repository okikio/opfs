#!/usr/bin/env bash
#MISE description="Run discovered tests on Node.js; optional files, --family, --shard"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/testing/run.ts node "$@"
