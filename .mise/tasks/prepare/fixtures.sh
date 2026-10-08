#!/usr/bin/env bash
#MISE description="Download stored test fixtures and verify their SHA-256"
set -euo pipefail
exec node tools/fixtures/store.ts fetch
