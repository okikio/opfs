#!/usr/bin/env bash
#MISE description="Type-check every complete Markdown example"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/check/examples.ts --check
