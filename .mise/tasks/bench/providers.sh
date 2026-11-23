#!/usr/bin/env bash
#MISE description="Benchmark provider clients against Testcontainers baselines"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node --expose-gc bench/providers.ts "$@"
