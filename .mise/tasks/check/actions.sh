#!/usr/bin/env bash
#MISE description="Validate the GitHub Actions workflows and local actions"
#MISE hide=true
#MISE depends=[]
# Three pinned tools, as in Kaiju's shared Actions check:
# - jactionlint (jdx's actionlint fork): syntax, expressions, permissions and script injection,
#   plus shellcheck on each run step.
# - zizmor: workflow security audit. Offline, it skips its online audits.
# - pinact: every action is pinned to a full commit SHA with a matching version comment. Offline,
#   it checks the pins but cannot confirm the version comments.
# The online audits run only in GitHub Actions with the job token. A local shell token can be
# stale or scoped to another account, and act has no real GitHub API behind it.
set -euo pipefail
online=false
if [[ "${GITHUB_ACTIONS:-}" == true && "${ACT:-}" != true && -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
	online=true
fi

echo '==> jactionlint'
jactionlint "$@"

echo '==> zizmor'
zizmor_args=(-q --no-progress --color=never --strict-collection '--collect=workflows,actions')
$online || zizmor_args+=(--offline)
zizmor "${zizmor_args[@]}" .github

echo '==> pinact'
pinact_args=(run --check)
$online || pinact_args=(run --fix=false --no-api)
pinact "${pinact_args[@]}"
