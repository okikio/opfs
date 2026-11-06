#!/bin/dash
# Test-only signed Debian closure, started by acquire-run.ts in an owned container.
set -eu
export DEBIAN_FRONTEND=noninteractive
stage=${1:?Expected download or install stage}
root=${2:?Expected owned receipt directory}
tool=${3:?Expected copied apt.ts path}
if [ "$stage" = download ]; then
  mkdir -p "$root/apt-trust" "$root/licenses" "$root/debs"
  cp /etc/os-release "$root/os-release.snapshot"
  find /etc/apt -maxdepth 3 -type f -exec sh -c 'for p do printf "\nPATH %s\n" "$p"; cat "$p"; done' sh {} + > "$root/apt-configuration.snapshot"
  find /usr/share/keyrings -maxdepth 1 -type f -name '*archive*' -exec sha256sum {} + > "$root/apt-trust/keyrings.sha256"
  if [ -f /etc/apt/apt.conf.d/docker-clean ]; then
    cp /etc/apt/apt.conf.d/docker-clean "$root/docker-clean.original.snapshot"
    printf '// Disabled only in this disposable archive-receipt container.\n' > /etc/apt/apt.conf.d/docker-clean
  fi
  printf 'APT::Keep-Downloaded-Packages "true";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/99opfs-keep-archives
  apt-config dump > "$root/apt-effective.snapshot"
  dpkg-query -W '-f=${binary:Package}\t${Version}\n' > "$root/packages-before.tsv"
  apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update
  apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 --download-only install -y --no-install-recommends gdal-bin libgdal-dev libtiff-dev libtiff-tools g++
  node "$tool" admit --root "$root" --profile geotiff
  exit 0
fi
if [ "$stage" != install ]; then
  echo 'Unknown acquisition stage' >&2
  exit 2
fi
# This phase belongs in a separately created --network none container.
node "$tool" verify --root "$root" --profile geotiff
apt-get --no-download --no-install-recommends -y install "$root"/debs/*.deb
dpkg-query -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\n' > "$root/packages-after.tsv"
node "$tool" notices --root "$root" --profile geotiff
find /var/lib/apt/lists -maxdepth 1 -type f -exec sha256sum {} + > "$root/apt-index-sha256.txt"
sha256sum /usr/bin/gdalinfo /usr/bin/gdal-config /usr/bin/g++ /usr/bin/tiffinfo /usr/local/bin/node > "$root/binaries.sha256"
/usr/bin/gdalinfo --version > "$root/gdal-version.txt"
/usr/bin/gdal-config --version > "$root/gdal-development-version.txt"
/usr/bin/g++ --version > "$root/compiler-version.txt"
/usr/bin/tiffinfo -h > "$root/tiffinfo-version.txt" 2>&1 || test "$?" -eq 1
node "$tool" inventory --root "$root" --profile geotiff
