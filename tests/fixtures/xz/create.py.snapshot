"""Genuine XZ Utils containers, full-byte checked by Python liblzma and independent 7-Zip.

python3 tests/fixtures/xz/create.py --seven /usr/bin/7zz --output /tmp/xz.json
No candidate OPFS parser/decoder is used. Adapted trailing padding is labelled explicitly.
"""
import argparse
import base64
import hashlib
import json
import lzma
import pathlib
import random
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--seven', default='7zz')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()

def command(argv, **options):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=40, **options)
    if result.returncode:
        raise RuntimeError(json.dumps({'argv': argv, 'exitCode': result.returncode,
            'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}))
    return result.stdout

def crc64(body):
    # Independent arbitrary-precision bitwise oracle, not the candidate's two-word table.
    state = (1 << 64) - 1
    for byte in body:
        state ^= byte
        for _ in range(8):
            state = (state >> 1) ^ (0xC96C5795D7870F42 if state & 1 else 0)
    return state ^ ((1 << 64) - 1)
assert crc64(b'123456789') == 0x995DC9BBDF1939FA
assert crc64(b'') == 0

def vli(raw, at):
    value = 0
    for shift in range(0, 63, 7):
        byte = raw[at]; at += 1
        value |= (byte & 127) << shift
        if not byte & 128: return value, at
    raise RuntimeError('Native VLI exceeds documented encoding')

def checks64(raw, body):
    import struct
    assert raw[7] == 4
    index_at = len(raw) - 12 - (struct.unpack_from('<I', raw, len(raw)-8)[0] + 1) * 4
    assert raw[index_at] == 0
    count, at = vli(raw, index_at + 1)
    physical = 12; decoded = 0; checks = []
    for _ in range(count):
        unpadded, at = vli(raw, at); size, at = vli(raw, at)
        padded = (unpadded + 3) & ~3
        check_at = physical + padded - 8
        stored = struct.unpack_from('<Q', raw, check_at)[0]
        expected = crc64(body[decoded:decoded+size])
        assert stored == expected
        checks.append({'offset': check_at, 'decodedOffset': decoded, 'decodedBytes': size, 'hex': f'{expected:016x}'})
        physical += padded; decoded += size
    assert decoded == len(body)
    return checks

rng = random.Random(92311)
period = bytes(rng.randrange(256) for _ in range(65000))
bodies = {'empty': b'', 'literal': b'Independent XZ container payload\x00\xff',
          'overlap': b'a' * 9000, 'wrap': period * 3 + period[:117], 'vector': b'123456789'}
profiles = [
    ('crc32-empty', 'empty', ['-T1', '--check=crc32', '--lzma2=dict=64KiB']),
    ('crc32-literal', 'literal', ['-T1', '--check=crc32', '--lzma2=dict=64KiB']),
    ('none-literal', 'literal', ['-T1', '--check=none', '--lzma2=dict=64KiB']),
    ('crc32-overlap', 'overlap', ['-T1', '--check=crc32', '--lzma2=dict=4KiB']),
    ('crc32-wrap', 'wrap', ['-T1', '--check=crc32', '--lzma2=dict=64KiB']),
    ('crc32-blocks', 'wrap', ['-T1', '--check=crc32', '--block-size=65536', '--lzma2=dict=64KiB']),
    ('crc32-threaded', 'wrap', ['-T2', '--check=crc32', '--block-size=65536', '--lzma2=dict=64KiB']),
    ('crc64-literal', 'literal', ['-T1', '--check=crc64', '--lzma2=dict=64KiB']),
    ('crc64-empty', 'empty', ['-T1', '--check=crc64', '--lzma2=dict=64KiB']),
    ('crc64-vector', 'vector', ['-T1', '--check=crc64', '--lzma2=dict=64KiB']),
    ('crc64-wrap', 'wrap', ['-T1', '--check=crc64', '--lzma2=dict=64KiB']),
    ('crc64-default-threaded', 'wrap', ['-T2', '--block-size=65536', '--lzma2=dict=64KiB']),
    ('sha256-refusal', 'literal', ['-T1', '--check=sha256', '--lzma2=dict=64KiB']),
    ('delta-refusal', 'literal', ['-T1', '--check=crc32', '--delta=dist=1', '--lzma2=dict=64KiB']),
    ('bcj-refusal', 'literal', ['-T1', '--check=crc32', '--x86', '--lzma2=dict=64KiB']),
]
result = {'tools': {'xz': command(['xz', '--version']).decode().strip(),
                    '7zip': command([args.seven]).decode(errors='replace').splitlines()[:5]}, 'cases': []}
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    for name, body_name, flags in profiles:
        body = bodies[body_name]
        source = root / (name + '.bin')
        source.write_bytes(body)
        raw = command(['xz', *flags, '-c', str(source)])
        path = root / (name + '.xz')
        path.write_bytes(raw)
        assert lzma.decompress(raw) == body, name
        assert command([args.seven, 'x', '-so', str(path)]) == body, name
        check_evidence = {}
        if raw[7] == 4:
            checks = checks64(raw, body)
            check_evidence['crc64Checks'] = checks
            if checks:
                damaged = bytearray(raw); damaged[checks[0]['offset']] ^= 1
                bad = root / (name + '-corrupt.xz'); bad.write_bytes(damaged)
                failures = []
                for consumer in [[args.seven, 'x', '-so', str(bad)], ['xz', '-dc', str(bad)]]:
                    observed = subprocess.run(consumer, stdin=subprocess.DEVNULL, capture_output=True, timeout=40)
                    assert observed.returncode != 0, consumer
                    failures.append({'consumer': consumer[0], 'exitCode': observed.returncode, 'stderr': observed.stderr.decode(errors='replace')})
                check_evidence['nativeChecksumCorruptionFailures'] = failures
        result['cases'].append({'name': name, 'command': ['xz', *flags, '-c', name+'.bin'],
            'archive': base64.b64encode(raw).decode(), 'body': base64.b64encode(body).decode(),
            'sha256': hashlib.sha256(raw).hexdigest(), 'supported': not name.endswith('-refusal'),
            'origin': 'Genuine XZ Utils container; Python liblzma and independent 7-Zip full-byte consumers', **check_evidence})
    original = next(case for case in result['cases'] if case['name'] == 'crc32-literal')
    padded = base64.b64decode(original['archive']) + b'\0' * 20
    path = root / 'padded.xz'; path.write_bytes(padded)
    body = bodies['literal']
    try:
        convenience = lzma.decompress(padded)
        python_padding = {'convenienceAccepted': True}
        assert convenience == body
    except lzma.LZMAError as error:
        python_padding = {'convenienceAccepted': False, 'error': str(error)}
    decoder = lzma.LZMADecompressor()
    assert decoder.decompress(padded) == body
    assert decoder.eof and decoder.unused_data == b'\0' * 20
    python_padding['incrementalEof'] = True
    python_padding['unusedDataBase64'] = base64.b64encode(decoder.unused_data).decode()
    assert command(['xz', '-dc', str(path)]) == body
    assert command([args.seven, 'x', '-so', str(path)]) == body
    result['cases'].append({'name': 'crc32-padded', 'archive': base64.b64encode(padded).decode(),
        'body': base64.b64encode(body).decode(), 'sha256': hashlib.sha256(padded).hexdigest(), 'supported': True,
        'origin': 'Explicit authored 20-byte Stream Padding appended to genuine XZ container; xz CLI and independent 7-Zip full-byte acceptance; Python low-level EOF/unused_data examines trailing framing', 'pythonPadding': python_padding})
pathlib.Path(args.output).write_text(json.dumps(result, indent=2)+'\n')
