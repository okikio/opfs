#!/usr/bin/env python3
"""Authored ZIP method-14 producers and reciprocal full-byte consumers.

Python ZIP_LZMA (seekable and forward-only) plus genuine 7-Zip LZMA writers.
Python zipfile and 7-Zip compare all original bytes; libarchive also compares
every nonempty member. Its exact observed empty-LZMA refusal is a diagnostic.
No candidate code or upstream setup is imported. Native tools are test-only.
"""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import platform
import struct
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--seven', default='7zz')
parser.add_argument('--bsdtar', default='bsdtar')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()


def observe(argv, **kwargs):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=90, **kwargs)


def command(argv, **kwargs):
    result = observe(argv, **kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'command': argv, 'exitCode': result.returncode,
                                      'stdout': result.stdout.decode(errors='replace'),
                                      'stderr': result.stderr.decode(errors='replace')}))
    return result.stdout


def encoded(data):
    return {'base64': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()}


class Forward(io.BytesIO):
    """No seeks means the genuine Python writer must emit data descriptors."""
    def seek(self, *args):
        raise io.UnsupportedOperation('forward-only producer')


bodies = {'empty.bin': b'', 'odd.bin': b'odd\x00\xffbinary\r\n',
          'repeat.bin': b'A' * 80003,
          'many.bin': bytes((i * 31 + i // 251 + 17) % 251 for i in range(230017))}
fixtures = []
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    for name, body in bodies.items():
        (root / name).write_bytes(body)
    for producer in ['python', 'python-descriptor', 'seven-64k', 'seven-1m']:
        path = root / (producer + '.zip')
        if producer.startswith('seven'):
            command([args.seven, 'a', '-tzip', '-mm=LZMA', '-md=' + producer.split('-')[1],
                     str(path), *bodies], cwd=root)
        else:
            output = Forward() if producer == 'python-descriptor' else io.BytesIO()
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_LZMA) as archive:
                for name, body in bodies.items():
                    archive.writestr(name, body)
            path.write_bytes(output.getvalue())
        raw = path.read_bytes()
        members = []
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                original = bodies[info.filename]
                assert archive.read(info) == original
                assert command([args.seven, 'e', '-so', str(path), info.filename]) == original
                libarchive = observe([args.bsdtar, '-xOf', str(path), info.filename])
                # This exact native consumer refusal is not positive parity.
                # Python+7-Zip already verified the complete empty original above.
                empty_refusal = (not original and info.compress_type == 14
                                 and libarchive.returncode == 1 and libarchive.stdout == b''
                                 and b'lzma unknown error 10' in libarchive.stderr)
                if not empty_refusal:
                    assert libarchive.returncode == 0, libarchive.stderr.decode(errors='replace')
                    assert libarchive.stdout == original
                local = info.header_offset
                name_size, extra_size = struct.unpack_from('<HH', raw, local + 26)
                start = local + 30 + name_size + extra_size
                assert info.compress_type in [0, 14]
                wire = None
                if info.compress_type == 14:
                    assert info.extract_version >= 63
                    assert info.flag_bits & 2, 'Initial supported profile requires the native EOS flag'
                    property_size = struct.unpack_from('<H', raw, start + 2)[0]
                    assert property_size == 5
                    wire = {'sdkVersionBytes': list(raw[start:start + 2]), 'propertySize': property_size,
                            'propertyBytesHex': raw[start + 4:start + 9].hex(),
                            'dictionaryBytes': struct.unpack_from('<I', raw, start + 5)[0]}
                if producer == 'python-descriptor':
                    assert info.flag_bits & 8
                members.append({'name': info.filename, 'method': info.compress_type,
                                'flags': info.flag_bits, 'offset': start,
                                'compressedSize': info.compress_size, 'crc32': info.CRC,
                                'wire': wire, 'original': encoded(original),
                                'consumers': {'python': 'full-byte-match', 'seven': 'full-byte-match',
                                              'libarchive': {'status': 'empty-lzma-refused' if empty_refusal else 'full-byte-match',
                                                             'exitCode': libarchive.returncode,
                                                             'stdoutSha256': hashlib.sha256(libarchive.stdout).hexdigest(),
                                                             'stderr': libarchive.stderr.decode(errors='replace')}}})
        fixtures.append({'name': producer, 'archive': encoded(raw), 'members': members})

receipt = {'python': platform.python_version(),
           'seven': command([args.seven]).decode(errors='replace').splitlines()[:5],
           'bsdtar': command([args.bsdtar, '--version']).decode().strip(),
           'packages': command(['dpkg-query', '-W', '7zip', 'libarchive-tools', 'python3']).decode().splitlines(),
           'producerSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
           'fixtures': fixtures}
pathlib.Path(args.output).write_text(json.dumps(receipt, separators=(',', ':')) + '\n')
