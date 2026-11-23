#!/usr/bin/env bash
#MISE description="Run Playwright browser tests; optional Playwright arguments"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.ts "$@"
