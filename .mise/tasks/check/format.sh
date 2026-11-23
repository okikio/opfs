#!/usr/bin/env bash
#MISE description="Check formatting without modifying authored files"
set -euo pipefail
exec deno fmt --check
