#!/usr/bin/env bash
#MISE description="Install the pinned Playwright browsers and their system packages"
#MISE depends=["prepare:deps"]
set -euo pipefail
# Default to every engine the browser tests use. A quoted "${@:-a b c}" default would pass one argument.
if [[ $# -eq 0 ]]; then set -- chromium firefox webkit; fi
# Use the test runner's own CLI. node_modules/playwright can be a different version, and its browser builds
# would not match the ones @playwright/test launches.
cli=(node node_modules/@playwright/test/cli.js)

# OPFS_PLAYWRIGHT_APT names a folder of Ubuntu .deb files, which CI caches (.github/actions/playwright-cache).
# Without it, or off apt-based Linux, Playwright installs its system packages itself.
debs="${OPFS_PLAYWRIGHT_APT:-}"
if [[ -z "$debs" ]] || ! command -v apt-get >/dev/null; then exec "${cli[@]}" install --with-deps "$@"; fi

# Hit: the folder holds every package apt downloaded last time. --no-download installs them without refreshing
# apt's index or reaching a mirror. apt checks each file's dependencies, but a local .deb has no signature to
# check, so CI writes this folder's cache only from trusted refs. A slow Ubuntu mirror once spent a whole
# 10-minute job on this download.
if compgen -G "$debs/*.deb" >/dev/null &&
	sudo apt-get install --yes --no-install-recommends --no-download "$debs"/*.deb; then
	echo "Installed Playwright's Ubuntu packages from $(find "$debs" -name '*.deb' | wc -l) cached files."
	exec "${cli[@]}" install "$@"
fi

# Miss, or the cached files no longer fit this runner image: install normally, but have apt download into the
# cache folder. The runner deletes .deb files from /var/cache/apt/archives after installing, so copying them
# from there afterwards finds almost nothing.
rm -rf "$debs"
mkdir -p "$debs/partial"
sudo apt-get update
# Playwright's dry run simulates the install and lists every missing package, dependencies included.
mapfile -t packages < <("${cli[@]}" install-deps --dry-run "$@" | sed -n 's/^  \([^ ]\+\)$/\1/p')
if [[ ${#packages[@]} -gt 0 ]]; then
	sudo apt-get install --yes --no-install-recommends -o "Dir::Cache::Archives=$debs" \
		-o APT::Keep-Downloaded-Packages=true "${packages[@]}"
fi
sudo rm -rf "$debs/partial" "$debs/lock"
sudo chown -R "$(id -u):$(id -g)" "$debs"
echo "Kept $(find "$debs" -name '*.deb' | wc -l) Ubuntu packages for the next run."
# The dry run exits nonzero while anything is still missing; only then let Playwright install it itself.
if ! "${cli[@]}" install-deps --dry-run "$@" >/dev/null; then exec "${cli[@]}" install --with-deps "$@"; fi
exec "${cli[@]}" install "$@"
