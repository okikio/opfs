#!/usr/bin/env bash
#MISE description="Record the public symbols per subpath in tests/package/exports.json"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/check/exports.ts --write
