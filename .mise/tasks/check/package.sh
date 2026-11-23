#!/usr/bin/env bash
#MISE description="Build the npm package and test it from a clean consumer"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec deno run --frozen --config deno.json -A tools/npm/pack.ts --verify
