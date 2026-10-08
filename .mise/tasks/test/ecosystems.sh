#!/usr/bin/env bash
#MISE description="Test pinned ecosystem consumers (unstorage, Drizzle, RxDB) from a clean install"
#MISE depends=["prepare:deps"]
set -euo pipefail
exec node tools/testing/ecosystems.ts
