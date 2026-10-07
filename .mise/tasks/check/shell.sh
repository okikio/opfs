#!/usr/bin/env bash
#MISE description="Check authored shell scripts with shellcheck"
#MISE hide=true
#MISE depends=[]
# Authored shell is every tracked or new file ending in .sh, or starting with a shell shebang.
# Workflow run steps are checked separately, through jactionlint in check:actions.
set -euo pipefail
files=()
while IFS= read -r -d '' path; do
  [[ -f "$path" ]] || continue
  # Fixture recipes are pinned evidence: their bytes are hashed in provenance records and never edited.
  [[ "$path" == tests/fixtures/* ]] && continue
  if [[ "$path" == *.sh ]]; then
    files+=("$path")
  else
    IFS= read -r first < "$path" || true
    [[ "$first" =~ ^\#!.*(bash|/sh|dash|ksh)([[:space:]]|$) ]] && files+=("$path")
  fi
done < <(git ls-files --cached --others --exclude-standard -z)
((${#files[@]} > 0)) || { echo 'No authored shell scripts.'; exit 0; }
echo "==> shellcheck (${#files[@]} files)"
exec shellcheck "${files[@]}"
