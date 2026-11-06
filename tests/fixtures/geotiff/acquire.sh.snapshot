#!/bin/sh
# Test-only signed Debian tool closure. Never run this on the host or from production code.
set -eu
export DEBIAN_FRONTEND=noninteractive
mkdir -p /tool/debs /tool/licenses
cat /etc/os-release > /tool/os-release.snapshot
find /etc/apt -type f -maxdepth 3 -exec sh -c 'for p do printf "\nPATH %s\n" "$p"; cat "$p"; done' sh {} + > /tool/apt-configuration.snapshot
# Disable only the base's Docker archive-clean hook in this disposable tool container.
# Its original content is already in apt-configuration.snapshot and is retained separately here.
if [ -f /etc/apt/apt.conf.d/docker-clean ]; then
  cp /etc/apt/apt.conf.d/docker-clean /tool/docker-clean.original.snapshot
  printf '// Disabled for the reviewed OPFS tool archive receipt.\n' > /etc/apt/apt.conf.d/docker-clean
fi
printf 'APT::Keep-Downloaded-Packages "true";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/99opfs-keep-archives
apt-config dump > /tool/apt-effective.snapshot
dpkg-query -W -f='${binary:Package}\t${Version}\n' > /tool/packages-before.tsv
apt-get update
apt-get --download-only --no-install-recommends -y install python3-gdal gdal-bin python3-tifffile python3-numpy libtiff-tools
# The base's Python 3.13 is adequate for inert archive admission; Debian extensions later use /usr/bin/python3.
python3 - <<'PY'
import pathlib,subprocess,json,hashlib,shutil
paths=sorted(pathlib.Path('/var/cache/apt/archives').glob('*.deb'))
if not 0<len(paths)<=256:raise ValueError('tool archive member count')
rows=[];size=0;installed=0
for p in paths:
 n=p.stat().st_size
 if n>64*1024**2:raise ValueError('tool archive member bytes')
 size+=n
 if size>256*1024**2:raise ValueError('tool archive aggregate bytes')
 fields=subprocess.check_output(['dpkg-deb','--show','--showformat=${Package}\t${Version}\t${Architecture}\t${Source}\t${Installed-Size}',str(p)],timeout=10,text=True).split('\t')
 if len(fields)!=5:raise ValueError('package metadata cardinality')
 installed+=int(fields[4])*1024
 if installed>768*1024**2:raise ValueError('tool declared installed size')
 target=pathlib.Path('/tool/debs')/p.name;shutil.copyfile(p,target)
 rows.append({'file':p.name,'bytes':n,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'package':fields[0],'version':fields[1],'architecture':fields[2],'source':fields[3],'installedBytes':int(fields[4])*1024})
pathlib.Path('/tool/acquisition.json').write_text(json.dumps({'directRequests':['python3-gdal','gdal-bin','python3-tifffile','python3-numpy','libtiff-tools'],'downloadBytes':size,'declaredInstalledBytes':installed,'archives':rows},indent=2)+'\n')
PY
apt-get --no-download --no-install-recommends -y install /tool/debs/*.deb
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
