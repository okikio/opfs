#!/usr/bin/env bash
#MISE description="Install the published version in a fresh consumer: npm, jsr, jsr-npm or both"
set -euo pipefail
exec deno run -A tools/release/verify.ts "$@"
