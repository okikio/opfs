"""Independent CAB producer and consumer, run only as a fixture task.

python3 tests/fixtures/cab/create.py --gcab /usr/bin/gcab --cabextract /usr/bin/cabextract
Never imports or invokes OPFS. The original input files supply the full payload
oracle; gcab produces STORED/MSZIP CABs and cabextract independently verifies them.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--gcab', default='gcab')
parser.add_argument('--cabextract', default='cabextract')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()

def command(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, timeout=15, **kwargs)

producer = command([args.gcab, '--version']).stdout.decode().strip()
consumer = command([args.cabextract, '--version']).stdout.decode().strip()
result = {}
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    inputs = {'first.bin': bytes(range(73)),
              'large.bin': bytes((i * 31 + 17) % 251 for i in range(131072)),
              'last.bin': b'last\x00binary\xffbytes!', 'empty': b'', 'caf\u00e9.txt': b'UTF-8 name payload'}
    for name, body in inputs.items():
        (root / name).write_bytes(body)
        os.utime(root / name, (946684800, 946684800))
    for profile, flags in [('stored', []), ('mszip', ['-z'])]:
        archive = root / (profile + '.cab')
        argv = [args.gcab, '-c', *flags, str(archive), *inputs.keys()]
        command(argv, cwd=root)
        encoded = archive.read_bytes()
        destination = root / ('extract-' + profile)
        destination.mkdir()
        verified = command([args.cabextract, '-q', '-d', str(destination), str(archive)])
        for name, body in inputs.items():
            assert (destination / name).read_bytes() == body, (profile, name)
        result[profile] = {'producer': producer, 'consumer': consumer,
                           'command': [args.gcab, '-c', *flags, profile + '.cab', *inputs.keys()],
                           'consumerCommand': [args.cabextract, '-q', '-d', 'output', profile + '.cab'],
                           'sha256': hashlib.sha256(encoded).hexdigest(),
                           'archive': base64.b64encode(encoded).decode(),
                           'entries': [{'name': name, 'body': base64.b64encode(body).decode()} for name, body in inputs.items()]}
pathlib.Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
