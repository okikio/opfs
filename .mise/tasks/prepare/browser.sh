#!/usr/bin/env bash
#MISE description="Install the pinned Playwright browsers and their system packages"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node node_modules/playwright/cli.js install --with-deps "${@:-chromium firefox webkit}"
