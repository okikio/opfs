#!/usr/bin/env bash
#MISE description="Check Conventional Commit subjects between BASE_SHA and HEAD_SHA"
set -euo pipefail
exec deno run --allow-env=BASE_SHA,HEAD_SHA --allow-run tools/check/commits.ts
