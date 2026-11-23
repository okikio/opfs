#!/usr/bin/env bash
#MISE description="Install the pinned Playwright browsers and their system packages"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Default to every engine the browser tests use. A quoted "${@:-a b c}" default would pass one argument.
if [[ $# -eq 0 ]]; then set -- chromium firefox webkit; fi
# Use the test runner's own CLI. node_modules/playwright can be a different version, and its browser builds
# would not match the ones @playwright/test launches.
exec node node_modules/@playwright/test/cli.js install --with-deps "$@"
