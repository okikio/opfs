#!/usr/bin/env bash
#MISE description="Lint authored TypeScript"
set -euo pipefail
exec deno lint
