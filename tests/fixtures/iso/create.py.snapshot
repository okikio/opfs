"""Genuine xorriso/genisoimage images, independently extracted by isoinfo and bsdtar.

All tools are test-only. No image is mounted. Public original payloads form the oracle.
Run: python3 tests/fixtures/iso/create.py --output /tmp/independent.json
"""
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()

def command(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, stdin=subprocess.DEVNULL, timeout=40, **kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'argv': [arg.decode('iso-8859-1') if isinstance(arg, bytes) else arg for arg in argv], 'exitCode': result.returncode,
            'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}))
    return result.stdout

result = {'tools': {}, 'images': {}}
for name, argv in [('xorriso',['xorriso','-version']), ('genisoimage',['genisoimage','--version']),
                   ('bsdtar',['bsdtar','--version']), ('isoinfo',['isoinfo','-version'])]:
    result['tools'][name] = command(argv).decode(errors='replace').strip()
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    files = {'hello.txt': b'Independent ISO preview\n', 'empty': b'',
             'folder/Unicode caf\u00e9.txt': bytes(range(251))*3,
             'folder/keep space.txt': b'spaces stay literal',
             'unrelated.bin': bytes((i*19+3)%251 for i in range(1048576))}
    tree = root/'input'; tree.mkdir()
    for name, body in files.items():
        path = tree/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(body)
    for producer in ['xorriso','genisoimage']:
        for joliet in [False, True]:
            image = root/(producer+('-joliet' if joliet else '-primary')+'.iso')
            argv = (['xorriso','-as','mkisofs','--norock'] if producer=='xorriso' else ['genisoimage'])
            argv += ['-input-charset','utf-8','-iso-level','2','-V','OPFS_FIXTURE','-o',str(image)]
            if joliet: argv += ['-J']
            command(argv+[str(tree)])
            profiles = {}
            for namespace in (['primary','joliet'] if joliet else ['primary']):
                flags = ['-J','-j','iso8859-1'] if namespace=='joliet' else []
                listing = command(['isoinfo','-i',str(image),*flags,'-f'])
                names = listing.decode('iso-8859-1').splitlines()
                entries = []
                # isoinfo lists directories too; known data extents distinguish by size and content.
                for name in names:
                    body = command(['isoinfo','-i',str(image),*flags,'-x',name.encode('iso-8859-1')])
                    if name.upper().rstrip(';1') in ['/FOLDER']: continue
                    matches = [original for original, expected in files.items() if expected==body]
                    if len(matches)!=1: raise RuntimeError('Payload oracle does not identify '+name)
                    entries.append({'name':name, 'original':matches[0], 'body':base64.b64encode(body).decode()})
                if len(entries)!=len(files): raise RuntimeError('Missing source files in '+namespace)
                profiles[namespace] = entries
                # Preserve the tool's displayed names separately from native identifier bytes in the image.
                result.setdefault('listings', {})[producer+str(joliet)+namespace] = {
                    'base64':base64.b64encode(listing).decode(), 'displayEncoding':'iso-8859-1', 'flags':flags}
            # libarchive is independent of both producer implementations. It chooses Joliet when present.
            target=root/(producer+str(joliet));target.mkdir()
            command(['bsdtar','-xf',str(image),'-C',str(target)])
            extracted = []
            remaining = dict(files)
            for path in sorted(target.rglob('*')):
                if path.is_symlink(): raise RuntimeError('Unexpected extracted symlink '+str(path))
                if path.is_dir(): continue
                actual=path.read_bytes()
                matches=[name for name, body in remaining.items() if body==actual]
                if len(matches)!=1: raise RuntimeError('Unexpected/duplicate libarchive payload '+str(path))
                original=matches[0]; del remaining[original]
                extracted.append({'name':str(path.relative_to(target)), 'original':original,
                                  'sha256':hashlib.sha256(actual).hexdigest()})
            if remaining: raise RuntimeError('Missing libarchive payloads '+repr(list(remaining)))
            wire=image.read_bytes()
            result['images'][producer+('-joliet' if joliet else '-primary')]={
                'archive':base64.b64encode(wire).decode(), 'sha256':hashlib.sha256(wire).hexdigest(),
                'profiles':profiles, 'consumerEntries':extracted, 'consumer':'isoinfo full member bytes plus independent libarchive extracted full bytes'}
pathlib.Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
