#!/usr/bin/env bash
#MISE description="Preview the next version and changelog from pending Sampo changesets"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/release/plan.ts
