#!/usr/bin/env bash
#MISE description="Verify secret scanning with the pinned scanner and disposable Git repositories"
set -euo pipefail
exec mise exec gitleaks -- node --test tools/security/*.integration.ts
