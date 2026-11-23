#!/usr/bin/env bash
#MISE description="Run the browser OPFS benchmarks with Playwright"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node node_modules/@playwright/test/cli.js test --config bench/browser/playwright.config.ts "$@"
