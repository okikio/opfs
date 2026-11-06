"""SOURCE ONLY: later execute only the reviewed unchanged official function slice.

Adaptation: supply three stdlib bindings without importing botocore.utils or its
unadmitted dependency closure. Original Apache-2.0 copyright, LICENSE and NOTICE
remain alongside the full immutable source and unchanged function snapshot.
"""
import binascii
import hashlib
import io
import json
from itertools import zip_longest
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parent
FRAGMENT_SHA256 = '3df5e68cee20bbe60753d3a57dd25182ee7efed201f25d22b147cc9ae8b36eef'
MIB = 1024 * 1024

def main():
    if len(sys.argv) != 3:
        raise SystemExit('Use tree_oracle.py ORIGINAL_DIRECTORY NEW_OUTPUT_JSON')
    fragment = (BASE / 'botocore-tree-functions.py.snapshot').read_bytes()
    if hashlib.sha256(fragment).hexdigest() != FRAGMENT_SHA256:
        raise ValueError('Official unchanged function slice changed')
    # The exact hashed fragment contains only two reviewed function definitions.
    namespace = {'hashlib': hashlib, 'binascii': binascii, 'zip_longest': zip_longest}
    exec(fragment, namespace)
    official_tree = namespace['calculate_tree_hash']
    originals = Path(sys.argv[1]).resolve()
    manifest = json.loads((originals / 'originals.json').read_text())
    records = []
    for vector in manifest['vectors']:
        filename = vector['file']
        if Path(filename).name != filename or not filename.endswith('.bin'):
            raise ValueError('Original filename is not a literal owned basename')
        path = originals / filename
        if path.stat().st_size > 16 * MIB:
            raise ValueError('Original vector exceeds the 16 MiB policy')
        data = path.read_bytes()
        if len(data) != vector['size'] or hashlib.sha256(data).hexdigest() != vector['sha256']:
            raise ValueError('Original complete bytes differ from fixture manifest')
        leaf_hashes = [hashlib.sha256(data[start:start + MIB]).hexdigest() for start in range(0, len(data), MIB)]
        root = official_tree(io.BytesIO(data))
        parts = []
        if 'partSize' in vector:
            size = vector['partSize']
            if size < MIB or size % MIB or size & (size - 1):
                raise ValueError('Multipart fixture requires a power-of-two MiB part size')
            for start in range(0, len(data), size):
                part = data[start:start + size]
                parts.append({'start': start, 'endInclusive': start + len(part) - 1, 'size': len(part),
                              'linearSha256': hashlib.sha256(part).hexdigest(),
                              'leafHashes': [hashlib.sha256(part[offset:offset + MIB]).hexdigest() for offset in range(0, len(part), MIB)],
                              'treeHash': official_tree(io.BytesIO(part))})
        records.append({'id': vector['id'], 'file': filename, 'size': len(data), 'linearSha256': vector['sha256'],
                        'leafHashes': leaf_hashes, 'treeHash': root, **({'partSize': vector['partSize']} if 'partSize' in vector else {}), 'parts': parts})
    # The whole original byte stream is independent authority for completion root.
    # It is not a hash of concatenated part-root text or generated candidate leaves.
    result = {'authority': 'unchanged botocore 1.40.0 tree functions plus stdlib SHA-256 over complete originals',
              'fragmentSha256': FRAGMENT_SHA256, 'vectors': records}
    with Path(sys.argv[2]).open('x') as output:
        output.write(json.dumps(result, indent=2) + '\n')

if __name__ == '__main__':
    main()
