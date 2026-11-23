#!/usr/bin/env bash
#MISE description="Run provider tests against Testcontainers; optional --shard"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/test/suite.ts node --family provider "$@"
