#!/usr/bin/env bash
#MISE description="Move tracked fixtures over the size limit into the fixture store"
set -euo pipefail
exec node tools/fixtures/store.ts write
