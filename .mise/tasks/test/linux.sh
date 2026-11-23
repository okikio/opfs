#!/usr/bin/env bash
#MISE description="Run the Linux test lanes in named containers"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/test/linux.ts "$@"
