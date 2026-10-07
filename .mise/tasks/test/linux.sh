#!/usr/bin/env bash
#MISE description="Run the Linux test lanes in named containers"
#MISE depends=["prepare:deps", "prepare:fixtures"]
set -euo pipefail
# Earlier revisions carry the runner as a JavaScript module; the oldest have none, and the task is a no-op there.
for runner in tools/testing/linux.ts tools/testing/linux.mjs; do
  [[ -e $runner ]] && exec node "$runner" "$@"
done
echo "No Linux lane runner exists at this revision; nothing to run."
