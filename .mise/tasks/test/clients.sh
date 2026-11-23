#!/usr/bin/env bash
#MISE description="Compare filesystem clients (FUSE mounts) in a container"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tests/provider/fuse.ts "$@"
