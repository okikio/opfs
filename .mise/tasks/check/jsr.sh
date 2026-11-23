#!/usr/bin/env bash
#MISE description="Dry-run JSR publication of the source package"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec deno publish --frozen --dry-run --allow-dirty
