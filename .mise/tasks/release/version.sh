#!/usr/bin/env bash
#MISE description="Consume pending changesets into package.json, deno.json and CHANGELOG.md"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/release/version.ts
