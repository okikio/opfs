"""Authored wire mutations for native C CRC refusal; not genuine producer output."""
import argparse
import base64
import hashlib
import json
import pathlib
import resource
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--fixture', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
original = pathlib.Path(args.fixture).read_bytes()
fixture = next(value for value in json.loads(original)['fixtures'] if value['case'] == 'forks' and value['producer'] == 'macutils')
assert fixture['name'] == 'forks.bin'
alphabet = '!"#$%&\'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr'
wire = base64.b64decode(fixture['archive']['base64'])
packed = []
bits = 0
count = 0
for value in wire.split(b':')[1]:
    if value in (10, 13):
        continue
    bits = (bits << 6) | alphabet.index(chr(value))
    count += 6
    if count >= 8:
        count -= 8
        packed.append(bits >> count)
        bits &= (1 << count) - 1
raw = bytearray()
at = 0
while at < len(packed):
    value = packed[at]
    at += 1
    if value != 0x90:
        raw.append(value)
    else:
        repeat = packed[at]
        at += 1
        if repeat == 0:
            raw.append(0x90)
        else:
            raw.extend([raw[-1]] * (repeat - 1))
header_size = raw[0] + 20
assert len(raw) == header_size + 6 + fixture['data']['bytes'] + fixture['resource']['bytes']

def encode(value):
    # Literal marker escaping and independent sextet grouping, with no RLE runs.
    packed = bytearray()
    for byte in value:
        packed.append(byte)
        if byte == 0x90:
            packed.append(0)
    body = ':'
    for at in range(0, len(packed), 3):
        group = packed[at:at + 3]
        number = int.from_bytes(group, 'big') << (8 * (3 - len(group)))
        body += ''.join(alphabet[(number >> shift) & 63] for shift in [18, 12, 6, 0][: (len(group) * 8 + 5) // 6])
    body += ':'
    return ('(This file must be converted with BinHex 4.0)\n\n' + '\n'.join(body[at:at + 64] for at in range(0, len(body), 64)) + '\n').encode('ascii')

CAP = 2 * 1024 * 1024
commands = []

def limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (CAP, CAP))

def decode(path, output):
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        result = subprocess.run(['/usr/bin/hexbin', '-3', str(path)], cwd=output, stdout=stdout, stderr=stderr, timeout=60, preexec_fn=limits)
        stdout.seek(0); stderr.seek(0)
        out, err = stdout.read(CAP + 1), stderr.read(CAP + 1)
    assert len(out) <= CAP and len(err) <= CAP
    receipt = dict(code=result.returncode, stdout=out.decode('utf-8', 'replace'), stderr=err.decode('utf-8', 'replace'))
    commands.append(receipt)
    return receipt

with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    baseline = root / 'baseline.hqx'
    baseline.write_bytes(encode(raw))
    target = root / 'baseline'; target.mkdir()
    receipt = decode(baseline, target)
    assert receipt['code'] == 0, receipt
    assert {path.name for path in target.iterdir()} == {'forks.bin.info', 'forks.bin.data', 'forks.bin.rsrc'}
    assert (target / 'forks.bin.data').read_bytes() == base64.b64decode(fixture['data']['base64'])
    assert (target / 'forks.bin.rsrc').read_bytes() == base64.b64decode(fixture['resource']['base64'])
    data_size = fixture['data']['bytes']
    positions = [('header-type', raw[0] + 2), ('header-crc', header_size + 1), ('data-byte', header_size + 2),
                 ('data-crc', header_size + 3 + data_size), ('resource-byte', header_size + 4 + data_size), ('resource-crc', len(raw) - 1)]
    controls = []
    for name, offset in positions:
        changed = raw.copy(); changed[offset] ^= 1
        encoded = encode(changed)
        path = root / (name + '.hqx'); path.write_bytes(encoded)
        output = root / name; output.mkdir()
        receipt = decode(path, output)
        # Distinguish native checksum refusal from incidental setup or I/O failure.
        if receipt['code'] == 0 or not any(word in receipt['stderr'].lower() for word in ['crc', 'checksum']):
            raise RuntimeError(json.dumps(dict(name=name, receipt=receipt)))
        controls.append(dict(name=name, offset=offset, base64=base64.b64encode(encoded).decode(), sha256=hashlib.sha256(encoded).hexdigest(), native=receipt))
    result = dict(kind='authored wire mutations, not genuine producer outputs', inputSHA256=hashlib.sha256(original).hexdigest(),
                  scriptSHA256=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(), controls=controls, commands=commands)
    pathlib.Path(args.output).write_text(json.dumps(result, separators=(',', ':')) + '\n')
