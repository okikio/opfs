#!/usr/bin/env bash
#MISE description="Scan Git history for committed secrets"
set -euo pipefail
exec mise exec gitleaks -- node tools/security/secrets.ts "$@"
