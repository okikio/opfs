#!/usr/bin/env bash
#MISE description="Run Playwright browser tests; optional Playwright arguments"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e tests/browser/playwright.config.ts ]] || { echo "tests/browser/playwright.config.ts does not exist at this revision; nothing to run."; exit 0; }
exec node node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.ts "$@"
