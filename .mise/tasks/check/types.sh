#!/usr/bin/env bash
#MISE description="Type-check tracked repository TypeScript programs in their target environments"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/check/types.ts
