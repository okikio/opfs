"""Produce genuine UDF 1.02 images and verify their UDF namespace with native 7-Zip.

python3 create.py --seven /usr/bin/7zz --output /tmp/udf.json
No candidate parser is imported. Original source bytes are the payload oracle.
"""
import argparse
import base64
import binascii
import hashlib
import json
import os
import pathlib
import random
import subprocess
import struct
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--seven', default='7zz')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()

def run(argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(json.dumps({'argv': argv, 'exitCode': result.returncode,
            'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}))
    return result.stdout

rng = random.Random(120102)
bodies = {'empty': b'', 'folder/first.bin': b'Independent UDF bytes\0\xff',
    'large.bin': bytes(rng.randrange(256) for _ in range(65573)),
    'unrelated.bin': bytes(rng.randrange(256) for _ in range(1024*1024)),
    'caf\u00e9.bin': b'Latin1 name', '\u96ea.bin': b'UCS2 name'}
for index in range(65):
    bodies[f'cross/entry-{index:02d}-long-name.bin'] = bytes([index, 0, 255])
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary); tree = root/'tree'; tree.mkdir()
    for name, body in bodies.items():
        file = tree/name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(body)
    os.link(tree/'folder/first.bin', tree/'alias.bin')
    bodies['alias.bin'] = bodies['folder/first.bin']
    image = root/'image.udf'
    command = ['genisoimage', '-quiet', '-udf', '-no-pad', '-input-charset', 'utf-8', '-V', 'OPFS_UDF102', '-o', str(image), str(tree)]
    run(command)
    listing = run([args.seven, 'l', '-tUdf', '-slt', str(image)]).decode('utf-8')
    if 'Type = Udf' not in listing:
        raise RuntimeError('Independent consumer did not select the UDF handler')
    entries = []
    for name, body in bodies.items():
        actual = run([args.seven, 'x', '-tUdf', '-spd', '-so', str(image), name])
        if actual != body: raise RuntimeError(f'Independent UDF full-byte consumer mismatch: {name}')
        entries.append({'name': name, 'body': base64.b64encode(body).decode(), 'sha256': hashlib.sha256(body).hexdigest()})
    info = run(['udfinfo', str(image)]).decode('utf-8')
    raw = image.read_bytes()
    help_probe = subprocess.run(['udfinfo', '--help'], stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
    version_probe = subprocess.run(['udfinfo', '--version'], stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
    # Adapt a genuine recorded file's allocation vector, not its payload bytes.
    # Native forced-UDF extraction verifies each complete adapted image independently.
    large_size = len(bodies['large.bin'])
    found = []
    for offset in range(0, len(raw), 2048):
        if struct.unpack_from('<H', raw, offset)[0] == 261 and raw[offset+27] == 5 and struct.unpack_from('<Q', raw, offset+56)[0] == large_size:
            found.append(offset)
    assert len(found) == 1
    fe = found[0]
    ea = struct.unpack_from('<I', raw, fe+168)[0]
    ad = fe + 176 + ea
    assert struct.unpack_from('<I', raw, fe+172)[0] == 8
    extent_length, extent_block = struct.unpack_from('<II', raw, ad)
    assert extent_length == large_size
    adaptations = []
    for profile in ['long', 'split-short', 'split-long']:
        adapted = bytearray(raw)
        width = 16 if profile in ['long', 'split-long'] else 8
        extents = [(extent_length, extent_block)] if profile == 'long' else [(2048, extent_block), (extent_length-2048, extent_block+1)]
        struct.pack_into('<H', adapted, fe+34, (struct.unpack_from('<H', adapted, fe+34)[0] & ~7) | (1 if width == 16 else 0))
        struct.pack_into('<I', adapted, fe+172, width*len(extents))
        adapted[ad:ad+width*len(extents)] = bytes(width*len(extents))
        for index, (length, block) in enumerate(extents):
            struct.pack_into('<II', adapted, ad+width*index, length, block)
        crc_length = 176 + ea + width*len(extents) - 16
        struct.pack_into('<H', adapted, fe+10, crc_length)
        struct.pack_into('<H', adapted, fe+8, binascii.crc_hqx(adapted[fe+16:fe+16+crc_length], 0))
        adapted[fe+4] = sum(adapted[fe:fe+4] + adapted[fe+5:fe+16]) & 255
        path = root/(profile+'.udf'); path.write_bytes(adapted)
        adapted_listing = run([args.seven, 'l', '-tUdf', '-slt', str(path)]).decode('utf-8')
        assert 'Type = Udf' in adapted_listing
        for name, body in bodies.items():
            assert run([args.seven, 'x', '-tUdf', '-spd', '-so', str(path), name]) == body, (profile, name)
        adaptations.append({'name': profile, 'archive': base64.b64encode(adapted).decode(), 'sha256': hashlib.sha256(adapted).hexdigest(),
            'origin': 'Explicit authored allocation-vector adaptation of genuine genisoimage UDF; every original file independently accepted by forced-UDF 7-Zip handler',
            'changedIcbOffset': fe, 'udfinfo': run(['udfinfo', str(path)]).decode('utf-8')})
    result = {'tools': {'genisoimage': run(['genisoimage', '--version']).decode().strip(),
        '7zip': run([args.seven]).decode(errors='replace').splitlines()[:5],
        'udftoolsPackage': run(['dpkg-query', '-W', '-f=${Version}', 'udftools']).decode().strip(),
        'udfinfoHelp': {'exitCode': help_probe.returncode, 'stdout': help_probe.stdout.decode(errors='replace'), 'stderr': help_probe.stderr.decode(errors='replace')}},
        'unsupportedVersionProbe': {'argv': ['udfinfo', '--version'], 'exitCode': version_probe.returncode, 'stdout': version_probe.stdout.decode(errors='replace'), 'stderr': version_probe.stderr.decode(errors='replace')},
        'command': command[:-2] + ['image.udf', 'tree'], 'listing': listing, 'udfinfo': info,
        'adaptations': adaptations,
        'archive': base64.b64encode(raw).decode(), 'sha256': hashlib.sha256(raw).hexdigest(), 'entries': entries,
        'origin': 'Genuine genisoimage -udf; all original bytes checked through explicitly forced 7-Zip UDF handler; udfinfo structural report'}
pathlib.Path(args.output).write_text(json.dumps(result, indent=2)+'\n')
