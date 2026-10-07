#!/usr/bin/env bash
#MISE description="Lint the public API documentation"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec deno doc --lint mod.ts
