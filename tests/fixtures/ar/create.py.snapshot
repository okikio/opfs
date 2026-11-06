"""Independent normal GNU/BSD ar producers and cross-GNU/LLVM payload consumers.

python3 tests/fixtures/ar/create.py --gnu /usr/bin/ar --llvm /usr/bin/llvm-ar --bsdtar /usr/bin/bsdtar
No candidate library code is imported. TAR/gzip bytes are produced by Python stdlib.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--gnu', default='ar')
parser.add_argument('--llvm', default='llvm-ar')
parser.add_argument('--bsdtar', default='bsdtar')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()

def command(argv, **kwargs):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=20, **kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'command': argv, 'exitCode': result.returncode,
                                      'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}))
    return result.stdout

with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    nested_body = b'Package: fixture\nVersion: 1.0\nArchitecture: all\n'
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        info = tarfile.TarInfo('control'); info.size = len(nested_body); info.mtime = 0
        archive.addfile(info, io.BytesIO(nested_body))
    bodies = {'first.bin': bytes(range(73)), 'large.bin': bytes((i*31+17)%251 for i in range(131072)),
              'last.bin': b'late\x00binary\xffpayload', 'empty': b'', '1234567890123456': b'sixteen-byte name',
              'a long filename with spaces.bin': b'long name payload', 'caf\u00e9 storage.bin': b'Unicode payload',
              'control.tar.gz': gzip.compress(tar.getvalue(), mtime=0)}
    for name, body in bodies.items():
        path = root/name; path.write_bytes(body); os.chmod(path, 0o644); os.utime(path, (946684800,946684800))
    result = {}
    for profile, tool, flags in [('gnu',args.gnu,[]),('bsd',args.llvm,['--format=bsd'])]:
        archive = root/(profile+'.a')
        argv = [tool,*flags,'qcD',str(archive),*bodies]
        command(argv,cwd=root)
        destination=root/('extract-'+profile); destination.mkdir()
        # libarchive exposes the GNU // metadata member as a pathname; retain
        # that unfiltered extraction failure rather than calling it payload proof.
        diagnostic_destination=root/('libarchive-'+profile); diagnostic_destination.mkdir()
        diagnostic = subprocess.run([args.bsdtar,'-xf',str(archive),'-C',str(diagnostic_destination)], stdin=subprocess.DEVNULL,
                                    capture_output=True, timeout=20)
        consumer = args.llvm if profile == 'gnu' else args.gnu
        command([consumer,'x',str(archive)], cwd=destination)
        for name,body in bodies.items(): assert (destination/name).read_bytes()==body,(profile,name)
        data=archive.read_bytes()
        result[profile]={'producer':command([tool,'--version']).decode(errors='replace').splitlines()[:3],
                         'consumer':command([consumer,'--version']).decode(errors='replace').splitlines()[:3],
                         'consumerCommand':[consumer,'x',profile+'.a'],
                         'libarchiveExtraction':{'version':command([args.bsdtar,'--version']).decode().strip(),
                                           'exitCode':diagnostic.returncode,'stdout':diagnostic.stdout.decode(errors='replace'),
                                           'stderr':diagnostic.stderr.decode(errors='replace')},
                         'command':[tool,*flags,'qcD',profile+'.a',*bodies],
                         'independentPayloadVerified':True,'sha256':hashlib.sha256(data).hexdigest(),
                         'archive':base64.b64encode(data).decode(),
                         'entries':[{'name':name,'body':base64.b64encode(body).decode()} for name,body in bodies.items()],
                         'nestedControl':base64.b64encode(nested_body).decode()}
    pathlib.Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
