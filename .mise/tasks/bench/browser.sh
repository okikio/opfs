#!/usr/bin/env bash
#MISE description="Run the browser OPFS benchmarks with Playwright"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e bench/browser/playwright.config.ts ]] || { echo "bench/browser/playwright.config.ts does not exist at this revision; nothing to run."; exit 0; }
exec node node_modules/@playwright/test/cli.js test --config bench/browser/playwright.config.ts "$@"
