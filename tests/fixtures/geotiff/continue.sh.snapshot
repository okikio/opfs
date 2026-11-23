#!/bin/sh
# Approved offline continuation. Preserve the ORIGINAL packages-before.tsv from the failed acquisition.
set -eu
export DEBIAN_FRONTEND=noninteractive
python3 - <<'VERIFY'
import pathlib,json,hashlib
p=pathlib.Path('/tool');manifest=json.loads((p/'acquisition.json').read_text());seen=set()
for row in manifest['archives']:
 name=row['file']
 if name in seen or '/' in name or chr(92) in name:raise ValueError('unexpected admitted archive name')
 seen.add(name);data=(p/'debs'/name).read_bytes()
 if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('admitted archive changed')
if seen!={f.name for f in (p/'debs').glob('*.deb')}:raise ValueError('archive closure changed')
if len(seen)!=102:raise ValueError('expected original 102-archive closure')
VERIFY
apt-get --fix-broken --no-remove --no-download --no-install-recommends -y install /tool/debs/*.deb
dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > /tool/packages-after.tsv
/usr/bin/python3 - <<'PY'
import sys,json,pathlib,subprocess,hashlib,ctypes.util
import numpy,tifffile
from osgeo import gdal
p=pathlib.Path('/tool');license_total=0;before={line.split('\t')[0]:line.split('\t')[1] for line in (p/'packages-before.tsv').read_text().splitlines()};licenses=[]
for line in (p/'packages-after.tsv').read_text().splitlines():
 name,version,source,sourceversion=line.split('\t')
 if before.get(name)==version:continue
 original=pathlib.Path('/usr/share/doc')/name.split(':')[0]/'copyright'
 if not original.is_file():raise ValueError('missing package copyright: '+name)
 data=original.read_bytes()
 if len(data)>1024**2:raise ValueError('license extent')
 license_total+=len(data)
 if license_total>8*1024**2:raise ValueError('aggregate license receipt extent')
 output=p/'licenses'/(name.replace(':','_')+'.copyright.snapshot');output.write_bytes(data)
 licenses.append({'package':name,'version':version,'source':source,'sourceVersion':sourceversion,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'file':str(output.relative_to(p))})
local=subprocess.check_output(['/usr/local/bin/python3','--version'],text=True,timeout=10).strip()
receipt={'systemPython':sys.version,'interpreter':sys.executable,'basePython':local,'numpy':{'version':numpy.__version__,'path':numpy.__file__},'tifffile':{'version':tifffile.__version__,'path':tifffile.__file__},'gdal':{'version':gdal.VersionInfo('--version'),'path':gdal.__file__},'libtiff':ctypes.util.find_library('tiff'),'licenses':licenses}
(p/'runtime.json').write_text(json.dumps(receipt,indent=2)+'\n')
PY
find /var/lib/apt/lists -type f -exec sha256sum {} + > /tool/apt-index-sha256.txt
