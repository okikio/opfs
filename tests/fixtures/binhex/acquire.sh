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
sha256sum /usr/bin/binhex /usr/bin/hexbin /usr/bin/perl /usr/local/bin/python3 > /receipts/binaries.sha256
for name in macutils libconvert-binhex-perl perl; do cp /usr/share/doc/$name/copyright /receipts/licenses/$name-copyright.txt; done
/usr/local/bin/python3 -I - <<'PY'
import hashlib
import json
import pathlib
import shutil
import sys
import sysconfig
assert sys.version_info[:3] == (3, 13, 12), sys.version
stdlib = pathlib.Path(sysconfig.get_path('stdlib'))
license_file = stdlib / 'LICENSE.txt'
# Missing license is a retained acquisition failure, not an implicit download.
shutil.copyfile(license_file, '/receipts/licenses/python-image-LICENSE.txt')
paths = [pathlib.Path(sys.executable).resolve(), stdlib / 'zipfile/__init__.py', stdlib / 'json/__init__.py', license_file]
result = dict(version=sys.version, executable=sys.executable, stdlib=str(stdlib),
              files={str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths})
pathlib.Path('/receipts/python.json').write_text(json.dumps(result, indent=2) + '\n')
PY
