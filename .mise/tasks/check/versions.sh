#!/usr/bin/env bash
#MISE description="Check that package.json, deno.json and Sampo agree on versions"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/release/manifest.ts
