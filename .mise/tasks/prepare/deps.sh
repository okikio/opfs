#!/usr/bin/env bash
#MISE description="Install the frozen dependency graph from deno.lock"
set -euo pipefail
exec deno ci
