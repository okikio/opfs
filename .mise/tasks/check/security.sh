#!/usr/bin/env bash
#MISE description="Check dependency advisories against reviewed, expiring exceptions"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/security/check.ts
