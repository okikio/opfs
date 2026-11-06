"""Independent MSZIP vectors: authored CAB framing, Python zlib payloads, native 7zz consumer.

No OPFS code is imported. Python's zdict produces real cross-block references;
the retained complete payload oracle is authored before any CAB is decoded.
Run: python3 tests/fixtures/cab/mszip.py --seven /opt/homebrew/bin/7zz
"""
import argparse
import base64
import hashlib
import json
import pathlib
import random
import struct
import subprocess
import tempfile
import zlib

parser = argparse.ArgumentParser()
parser.add_argument('--seven', default='7zz')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('mszip.json')))
args = parser.parse_args()


def parity(data):
    count = len(data) // 4 * 4
    result = 0
    for offset in range(0, count, 4):
        result ^= int.from_bytes(data[offset:offset + 4], 'little')
    return result ^ int.from_bytes(data[count:], 'big')


def encode(data):
    return base64.b64encode(data).decode()


version = subprocess.run([args.seven, 'i'], check=True, capture_output=True, timeout=20).stdout.decode()
rng = random.Random(20519)
history = bytes(rng.randrange(256) for _ in range(32768))
tail = history[1000:13000] + history[20000:30000]
profiles = [
    ('dynamic-history', [history, tail], 9, zlib.Z_DEFAULT_STRATEGY),
    ('fixed-history', [history, tail], 9, zlib.Z_FIXED),
    ('stored', [history, b'plain stored tail'], 0, zlib.Z_DEFAULT_STRATEGY),
    ('short-history', [history[:4096], history[4096:6144], history[:3000]], 9, zlib.Z_DEFAULT_STRATEGY),
    ('overlap', [b'A' * 32768, b'A' * 32768], 9, zlib.Z_DEFAULT_STRATEGY),
]
result = []
with tempfile.TemporaryDirectory(prefix='opfs-independent-mszip-') as directory:
    root = pathlib.Path(directory)
    for name, parts, level, strategy in profiles:
        blocks = []
        raw_blocks = []
        prior = b''
        dependencies = []
        for part in parts:
            options = dict(level=level, method=zlib.DEFLATED, wbits=-15, strategy=strategy)
            if prior:
                options['zdict'] = prior
            compressor = zlib.compressobj(**options)
            raw = compressor.compress(part) + compressor.flush()
            try:
                independent = zlib.decompress(raw, -15)
                dependent = independent != part
            except zlib.error:
                dependent = True
            decoder = zlib.decompressobj(-15, zdict=prior) if prior else zlib.decompressobj(-15)
            assert decoder.decompress(raw) + decoder.flush() == part
            assert decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
            packed = b'CK' + raw
            assert len(packed) <= 32780
            suffix = struct.pack('<HH', len(packed), len(part))
            blocks.append(struct.pack('<I', parity(packed) ^ parity(suffix)) + suffix + packed)
            raw_blocks.append(encode(packed))
            dependencies.append(dependent)
            prior = (prior + part)[-32768:]
        if 'history' in name or name == 'overlap':
            assert any(dependencies), name
        body = b''.join(parts)
        file_record = struct.pack('<IIHHHH', len(body), 0, 0, 0, 0, 32) + b'payload.bin\0'
        data_at = 44 + len(file_record)
        size = data_at + sum(map(len, blocks))
        header = struct.pack('<4sIIIIIBBHHHHH', b'MSCF', 0, size, 0, 44, 0, 3, 1, 1, 1, 0, 0, 0)
        archive = header + struct.pack('<IHH', data_at, len(blocks), 1) + file_record + b''.join(blocks)
        path = root / (name + '.cab')
        path.write_bytes(archive)
        argv = [args.seven, 'x', '-so', str(path), 'payload.bin']
        checked = subprocess.run(argv, capture_output=True, timeout=20)
        if name == 'short-history':
            assert checked.returncode != 0  # Retain native consumer limitation, not false acceptance.
        else:
            assert checked.returncode == 0, (name, checked.stderr.decode())
            assert checked.stdout == body, name
        result.append(dict(name=name, archive=encode(archive), body=encode(body),
                           parts=[encode(part) for part in parts], packed=raw_blocks,
                           requiresHistory=dependencies, consumerExit=checked.returncode,
                           consumerStderr=checked.stderr.decode(), consumerFullBytesMatch=checked.stdout == body,
                           consumerOutputBytes=len(checked.stdout), consumerOutputSha256=hashlib.sha256(checked.stdout).hexdigest(),
                           sha256=hashlib.sha256(archive).hexdigest()))
receipt = dict(producer='Authored MS-CAB framing and Python zlib ' + zlib.ZLIB_RUNTIME_VERSION,
               consumer=version, source='Original vectors; MS-MCI section 2 and RFC 1951',
               consumerCommand=['7zz', 'x', '-so', '<fixture.cab>', 'payload.bin'], vectors=result)
pathlib.Path(args.output).write_text(json.dumps(receipt, indent=2) + '\n')
