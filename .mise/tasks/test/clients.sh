#!/usr/bin/env bash
#MISE description="Compare filesystem clients (FUSE mounts) in a container"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Older revisions in the stack predate this tool; the task is a no-op there rather than a failure.
[[ -e tests/provider/fuse.ts ]] || { echo "tests/provider/fuse.ts does not exist at this revision; nothing to run."; exit 0; }
exec node tests/provider/fuse.ts "$@"
