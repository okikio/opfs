#!/bin/sh
# Test-only acquisition. Run in the parent-approved disposable image, not the host.
# apt verifies distribution Release/Packages metadata; retain every downloaded artifact hash before install hooks.
set -eu
mkdir -p /hdf5-tool/debs/partial /hdf5-tool/receipts/packages /hdf5-tool/receipts/licenses
cp /etc/os-release /hdf5-tool/receipts/os-release
apt-get update -qq
apt-get --assume-no --no-install-recommends install python3-h5py python3-numpy hdf5-tools > /hdf5-tool/receipts/proposal.txt 2>&1 || test "$?" -eq 1
apt-get -y --download-only --no-install-recommends -o Dir::Cache::archives=/hdf5-tool/debs install python3-h5py python3-numpy hdf5-tools
for archive in /hdf5-tool/debs/*.deb; do
  test -f "$archive" || continue
  sha256sum "$archive" >> /hdf5-tool/receipts/debs.sha256
  package=$(dpkg-deb -f "$archive" Package)
  version=$(dpkg-deb -f "$archive" Version)
  apt-cache show "$package=$version" > "/hdf5-tool/receipts/packages/$package.txt"
done
apt-get -y --no-download --no-install-recommends -o Dir::Cache::archives=/hdf5-tool/debs install python3-h5py python3-numpy hdf5-tools
for entry in /hdf5-tool/receipts/packages/*.txt; do
  package=$(basename "$entry" .txt)
  if test -f "/usr/share/doc/$package/copyright"; then
    cp "/usr/share/doc/$package/copyright" "/hdf5-tool/receipts/licenses/$package.txt"
  fi
done
for package in python3-h5py python3-numpy hdf5-tools; do
  version=$(dpkg-query -W -f='${Version}' "$package")
  apt-cache show "$package=$version" > "/hdf5-tool/receipts/packages/$package.txt"
done
dpkg-query -W > /hdf5-tool/receipts/installed.txt
/usr/bin/python3 -c 'import h5py,numpy,platform; print(platform.python_version(), h5py.__version__, numpy.__version__, h5py.version.hdf5_version)' > /hdf5-tool/receipts/versions.txt
h5dump --version >> /hdf5-tool/receipts/versions.txt
