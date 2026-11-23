#!/usr/bin/env bash
#MISE description="Repeat the portable Deno suite in shuffled order"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/test/suite.ts deno --family portable --stress "$@"
