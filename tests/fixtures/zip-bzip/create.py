#!/usr/bin/env python3
"""Authored ZIP method-12 interoperability fixtures; no candidate code is imported.

Python zipfile and signed-distribution 7-Zip independently produce archives.
Python zipfile, 7-Zip and libarchive extract every original byte. Python's
non-seekable writer independently exercises data descriptors. Tools are test-only.
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


def command(argv, **kwargs):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=90, **kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'command': argv, 'exitCode': result.returncode,
                                      'stdout': result.stdout.decode(errors='replace'),
                                      'stderr': result.stderr.decode(errors='replace')}))
    return result.stdout


def encoded(data):
    return {'base64': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()}


class Forward(io.BytesIO):
    """Refuse seeking so Python must write bit-3 data descriptors."""
    def seek(self, *args):
        raise io.UnsupportedOperation('forward-only fixture producer')


bodies = {'empty.bin': b'', 'odd.bin': b'odd\x00\xffbinary\r\n',
          'repeat.bin': b'A' * 80003,
          'many.bin': bytes((i * 31 + i // 251 + 17) % 251 for i in range(230017))}
fixtures = []
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    for name, body in bodies.items():
        (root / name).write_bytes(body)
    for producer in ['python', 'python-descriptor', 'seven']:
        for level in [1, 9]:
            path = root / ('%s-%s.zip' % (producer, level))
            if producer == 'seven':
                command([args.seven, 'a', '-tzip', '-mm=BZip2', '-mx=' + str(level),
                         str(path), *bodies], cwd=root)
            else:
                output = Forward() if producer == 'python-descriptor' else io.BytesIO()
                with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_BZIP2, compresslevel=level) as archive:
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
                    assert command([args.bsdtar, '-xOf', str(path), info.filename]) == original
                    local = info.header_offset
                    name_size, extra_size = struct.unpack_from('<HH', raw, local + 26)
                    start = local + 30 + name_size + extra_size
                    # Some native writers choose STORED for empty input. Retain
                    # this observable fact instead of pretending it exercises BZip2.
                    assert info.compress_type in [0, 12]
                    if info.compress_type == 12:
                        assert raw[start:start + 3] == b'BZh'
                        assert info.extract_version >= 46
                    if producer == 'python-descriptor':
                        assert info.flag_bits & 8
                    members.append({'name': info.filename, 'method': info.compress_type,
                                    'flags': info.flag_bits, 'offset': start,
                                    'compressedSize': info.compress_size, 'crc32': info.CRC,
                                    'original': encoded(original)})
            fixtures.append({'name': '%s-%s' % (producer, level), 'archive': encoded(raw), 'members': members})

receipt = {'python': platform.python_version(),
           'seven': command([args.seven]).decode(errors='replace').splitlines()[:5],
           'bsdtar': command([args.bsdtar, '--version']).decode().strip(),
           'packages': command(['dpkg-query', '-W', '7zip', 'libarchive-tools', 'python3']).decode().splitlines(),
           'producerSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
           'fixtures': fixtures}
pathlib.Path(args.output).write_text(json.dumps(receipt, separators=(',', ':')) + '\n')
