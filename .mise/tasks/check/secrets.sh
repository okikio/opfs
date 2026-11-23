#!/usr/bin/env bash
#MISE description="Scan Git history for committed secrets"
set -euo pipefail
exec gitleaks git --redact --no-banner --log-level warn --exit-code 1 "$@" .
