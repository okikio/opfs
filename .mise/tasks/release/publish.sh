#!/usr/bin/env bash
#MISE description="Publish this revision to one registry: --target npm|jsr"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/release/publish.ts "$@"
