set -eu
mkdir -p /receipts/apt-trust /receipts/licenses
cp /etc/apt/sources.list.d/* /receipts/apt-trust/
find /usr/share/keyrings -maxdepth 1 -type f -name '*archive*' -exec sha256sum {} + > /receipts/apt-trust/keyrings.sha256
apt-get update
apt-get --download-only install -y --no-install-recommends macutils libconvert-binhex-perl perl
find /var/cache/apt/archives -maxdepth 1 -type f -name '*.deb' -exec sha256sum {} + > /receipts/debs.sha256
apt-get install -y --no-install-recommends macutils libconvert-binhex-perl perl
cp /var/lib/apt/lists/*InRelease /receipts/apt-trust/
dpkg-query -W '-f=${Package}=${Version} ${Architecture}\n' macutils libconvert-binhex-perl perl > /receipts/packages.txt
sha256sum /usr/bin/binhex /usr/bin/hexbin /usr/bin/perl /usr/local/bin/node > /receipts/binaries.sha256
for name in macutils libconvert-binhex-perl perl; do cp /usr/share/doc/$name/copyright /receipts/licenses/$name-copyright.txt; done
node /tool/binhex/inspect.ts
