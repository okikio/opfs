#!/usr/bin/env bash
#MISE description="Check the storage expansion planning records"
set -euo pipefail
exec node planning/storage/research/validate.ts
