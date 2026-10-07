#!/usr/bin/env bash
#MISE description="Compare the Netlify client with the frozen SDK closure"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/testing/netlify.ts "$@"
