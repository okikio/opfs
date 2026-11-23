#!/usr/bin/env bash
#MISE description="Check that generated JSON Schemas match their Zod sources"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec deno run --frozen --allow-read tools/schema/types.ts --check
