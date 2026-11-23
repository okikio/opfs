#!/usr/bin/env bash
#MISE description="Type-check every tracked TypeScript file in its target environments"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/workspace/types.ts
