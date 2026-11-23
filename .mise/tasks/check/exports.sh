#!/usr/bin/env bash
#MISE description="Public symbols per subpath match tests/package/exports.json"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/check/exports.ts
