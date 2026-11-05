# Test-only signed Debian closure. Use acquire-run.py inside the reviewed container.
set -eu
export DEBIAN_FRONTEND=noninteractive
stage=${1:?Expected download or install stage}
if [ "$stage" = download ]; then
mkdir -p /receipts/apt-trust /receipts/licenses /receipts/debs
cp /etc/os-release /receipts/os-release.snapshot
find /etc/apt -maxdepth 3 -type f -exec sh -c 'for p do printf "\nPATH %s\n" "$p"; cat "$p"; done' sh {} + > /receipts/apt-configuration.snapshot
find /usr/share/keyrings -maxdepth 1 -type f -name '*archive*' -exec sha256sum {} + > /receipts/apt-trust/keyrings.sha256
if [ -f /etc/apt/apt.conf.d/docker-clean ]; then
  cp /etc/apt/apt.conf.d/docker-clean /receipts/docker-clean.original.snapshot
  printf '// Disabled only in this disposable archive-receipt container.\n' > /etc/apt/apt.conf.d/docker-clean
fi
printf 'APT::Keep-Downloaded-Packages "true";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/99opfs-keep-archives
apt-config dump > /receipts/apt-effective.snapshot
dpkg-query -W '-f=${binary:Package}\t${Version}\n' > /receipts/packages-before.tsv
apt-get update
apt-get --download-only install -y --no-install-recommends qemu-utils
# Retain and admit the exact downloaded dependency closure BEFORE installing it.
/usr/local/bin/python3 -I - <<'PY'
import hashlib
import json
import pathlib
import shutil
import subprocess
root = pathlib.Path('/receipts')
paths = sorted(pathlib.Path('/var/cache/apt/archives').glob('*.deb'))
if not 0 < len(paths) <= 256:
    raise ValueError('archive count exceeds 256 or closure is absent')
rows = []
size = 0
installed = 0
for path in paths:
    length = path.stat().st_size
    if length > 64 * 1024**2:
        raise ValueError('one archive exceeds 64 MiB')
    size += length
    if size > 256 * 1024**2:
        raise ValueError('downloaded closure exceeds 256 MiB')
    fields = subprocess.check_output(['dpkg-deb', '--show', '--showformat=${Package}\t${Version}\t${Architecture}\t${Source}\t${Installed-Size}', str(path)], timeout=10, text=True)
    if len(fields) > 65536:
        raise ValueError('package metadata receipt exceeds 64 KiB')
    name, version, architecture, source, declared = fields.split('\t')
    amount = int(declared) * 1024
    if amount < 0:
        raise ValueError('negative declared installed size')
    installed += amount
    if installed > 768 * 1024**2:
        raise ValueError('declared installed closure exceeds 768 MiB')
    target = root / 'debs' / path.name
    shutil.copyfile(path, target)
    rows.append(dict(file=path.name, bytes=length, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                     package=name, version=version, architecture=architecture, source=source, installedBytes=amount))
(root / 'acquisition.json').write_text(json.dumps(dict(directRequests=['qemu-utils'], downloadBytes=size,
    declaredInstalledBytes=installed, archives=rows), indent=2) + '\n')
PY
  exit 0
fi
if [ "$stage" != install ]; then
  echo "Unknown acquisition stage" >&2
  exit 2
fi
# Execute this phase only in a separately created --network none container.
# APT orders pre-dependencies from retained local files and fails without fetch.
/usr/local/bin/python3 -I - <<'PYVERIFY'
import hashlib
import json
import pathlib
root = pathlib.Path('/receipts')
manifest = json.loads((root / 'acquisition.json').read_text())
expected = {row['file']: row for row in manifest['archives']}
paths = {path.name: path for path in (root / 'debs').glob('*.deb')}
if paths.keys() != expected.keys():
    raise ValueError('admitted archive file set changed')
for name, path in paths.items():
    if path.stat().st_size != expected[name]['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != expected[name]['sha256']:
        raise ValueError('admitted archive bytes changed')
PYVERIFY
apt-get --no-download --no-install-recommends -y install /receipts/debs/*.deb
dpkg-query -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\n' > /receipts/packages-after.tsv
/usr/local/bin/python3 -I - <<'PY'
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import sysconfig
root = pathlib.Path('/receipts')
before = dict(line.split('\t') for line in (root / 'packages-before.tsv').read_text().splitlines())
licenses = []
total = 0
for line in (root / 'packages-after.tsv').read_text().splitlines():
    name, version, source, source_version, architecture = line.split('\t')
    if before.get(name) == version:
        continue
    path = pathlib.Path('/usr/share/doc') / name.split(':')[0] / 'copyright'
    if not path.is_file():
        raise ValueError('missing original package copyright: ' + name)
    data = path.read_bytes()
    if len(data) > 1024**2:
        raise ValueError('one copyright exceeds 1 MiB')
    total += len(data)
    if total > 8 * 1024**2:
        raise ValueError('copyright closure exceeds 8 MiB')
    target = root / 'licenses' / (name.replace(':', '_') + '.copyright.snapshot')
    target.write_bytes(data)
    licenses.append(dict(package=name, version=version, source=source, sourceVersion=source_version,
        architecture=architecture, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), file=str(target.relative_to(root))))
# Preserve complete standard license texts as well as the original package
# copyright notices that may refer to them. This is bounded test evidence.
for path in pathlib.Path('/usr/share/common-licenses').iterdir():
    if not path.is_file():
        continue
    data = path.read_bytes()
    if len(data) > 1024**2 or total + len(data) > 8 * 1024**2:
        raise ValueError('standard license texts exceed the license closure bound')
    total += len(data)
    target = root / 'licenses' / ('common-' + path.name + '.snapshot')
    target.write_bytes(data)
    licenses.append(dict(commonLicense=path.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), file=str(target.relative_to(root))))
assert sys.version_info[:3] == (3, 13, 12), sys.version
stdlib = pathlib.Path(sysconfig.get_path('stdlib'))
license_file = stdlib / 'LICENSE.txt'
shutil.copyfile(license_file, root / 'licenses/python-image-LICENSE.txt')
paths = [pathlib.Path(sys.executable).resolve(), stdlib / 'json/__init__.py', license_file]
python = dict(version=sys.version, executable=sys.executable, files={str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths})
(root / 'runtime.json').write_text(json.dumps(dict(python=python, licenses=licenses), indent=2) + '\n')
# Retain original signed release metadata; full package indices are represented
# by hashes, rather than duplicating an unbounded index tree into the receipts.
for path in pathlib.Path('/var/lib/apt/lists').glob('*InRelease'):
    if path.stat().st_size > 1024**2:
        raise ValueError('signed release receipt exceeds 1 MiB')
    shutil.copyfile(path, root / 'apt-trust' / path.name)
PY
find /var/lib/apt/lists -maxdepth 1 -type f -exec sha256sum {} + > /receipts/apt-index-sha256.txt
sha256sum /usr/bin/qemu-img /usr/bin/qemu-io /usr/local/bin/python3 > /receipts/binaries.sha256
/usr/bin/qemu-img --version > /receipts/qemu-img-version.txt
/usr/bin/qemu-img --help > /receipts/qemu-img-help.txt
/usr/bin/qemu-io --version > /receipts/qemu-io-version.txt
/usr/local/bin/python3 -I - <<'PY'
import pathlib
root = pathlib.Path('/receipts')
paths = [path for path in root.rglob('*') if path.is_file() and 'debs' not in path.relative_to(root).parts and not path.name.startswith('acquisition-download.') and not path.name.startswith('acquisition-install.')]
if len(paths) + 4 > 1024:
    raise ValueError('receipt file count exceeds 1,024')
# Reserve the complete log ceiling and final small wrapper receipt, not merely
# the current partially buffered log length observed before the wrapper settles.
if sum(path.stat().st_size for path in paths) + 4 * 1024**2 + 8192 > 64 * 1024**2:
    raise ValueError('non-archive receipts exceed 64 MiB including final log/runner reservation')
PY
