#!/usr/bin/env bash
#MISE description="Write JSON Schemas from their Zod sources"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec deno run --frozen --allow-read --allow-write tools/schema/types.ts
