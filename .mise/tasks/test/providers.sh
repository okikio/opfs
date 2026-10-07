#!/usr/bin/env bash
#MISE description="Run provider tests against Testcontainers; optional --shard"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/testing/run.ts node --family provider "$@"
