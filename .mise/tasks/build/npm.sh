#!/usr/bin/env bash
#MISE description="Build the npm package directory and tarball under .tmp/npm"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec deno run --frozen -A tools/npm/pack.ts "$@"
