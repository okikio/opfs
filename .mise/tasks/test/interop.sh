#!/usr/bin/env bash
#MISE description="Compare archives with installed 7-Zip, bsdtar and unzip"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
exec node tools/test/suite.ts deno --family interop "$@"
