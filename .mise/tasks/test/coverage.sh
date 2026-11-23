#!/usr/bin/env bash
#MISE description="Measure Deno line coverage of the portable suite"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/test/suite.ts deno --family portable --coverage "$@"
