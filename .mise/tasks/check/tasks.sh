#!/usr/bin/env bash
#MISE description="Validate the mise task graph"
set -euo pipefail
exec mise tasks validate
