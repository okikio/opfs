#!/usr/bin/env bash
#MISE description="Check that large fixtures live in the fixture store"
set -euo pipefail
exec node tools/fixtures/store.ts check
