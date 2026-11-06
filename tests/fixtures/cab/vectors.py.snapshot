"""Original CAB checksum vectors from MS-CAB section 3.1 mathematics.

These are constructed vectors, not gcab producer output. cabextract independently
checks ordinary vectors; reserved-area cases record both checksum conventions
and retain independent consumer failures without treating them as accepted. Production
code is neither imported nor invoked. Run with --cabextract /usr/bin/cabextract.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import struct
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--cabextract', default='cabextract')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('vectors.json')))
args = parser.parse_args()

def checksum(data):
    total = 0
    count = len(data) // 4 * 4
    for offset in range(0, count, 4):
        total ^= int.from_bytes(data[offset:offset+4], 'little')
    return total ^ int.from_bytes(data[count:], 'big')

consumer = subprocess.run([args.cabextract, '--version'], check=True, capture_output=True, timeout=15).stdout.decode().strip()
result = []
diagnostics = []
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    for size in [1, 2, 3, 4]:
        for reserve, scope in [(0, "fixed-header")] + [(n, scope) for n in [1, 2, 3] for scope in ["fixed-header", "header-and-reserve"]]:
            body = bytes([0x11, 0x22, 0x33, 0x44][:size])
            flags = 4 if reserve else 0
            reserve_header = struct.pack('<HBB', 0, 0, reserve) if reserve else b''
            files_at = 44 + len(reserve_header)
            data_at = files_at + 18
            suffix = struct.pack('<HH', size, size) + bytes([0x55, 0x66, 0x77][:reserve])
            check = checksum(body) ^ checksum(suffix if scope == "header-and-reserve" else suffix[:4])
            total_size = data_at + 4 + len(suffix) + len(body)
            header = struct.pack('<4sIIIIIBBHHHHH', b'MSCF', 0, total_size, 0, files_at, 0, 3, 1, 1, 1, flags, 0, 0)
            folder = struct.pack('<IHH', data_at, 1, 0)
            file = struct.pack('<IIHHHH', size, 0, 0, 0, 0, 32) + b'a\0'
            archive = header + reserve_header + folder + file + struct.pack('<I', check) + suffix + body
            assert len(archive) == total_size
            path = root / ('size%d-reserve%d-%s.cab' % (size, reserve, scope))
            path.write_bytes(archive)
            destination = root / ('size%d-reserve%d-%s' % (size, reserve, scope))
            destination.mkdir()
            checked = subprocess.run([args.cabextract, '-q', '-d', str(destination), str(path)], capture_output=True, timeout=15)
            accepted = checked.returncode == 0
            if accepted:
                assert (destination / 'a').read_bytes() == body
            if reserve == 0 and not accepted:
                raise RuntimeError('Ordinary vector consumer failed: ' + checked.stderr.decode(errors='replace'))
            target = result if reserve == 0 else diagnostics
            target.append({'size': size, 'blockReserveBytes': reserve, 'checksumScope': scope, 'consumerAccepted': accepted,
                           'consumerExitCode': checked.returncode, 'consumerStderr': checked.stderr.decode(errors='replace'), 'checksum': check,
                           'archive': base64.b64encode(archive).decode(), 'body': base64.b64encode(body).decode(),
                           'sha256': hashlib.sha256(archive).hexdigest()})
pathlib.Path(args.output).write_text(json.dumps({'source': 'Original vectors derived from Microsoft MS-CAB section 3.1 mathematics; independent cabextract validates payloads', 'consumer': consumer, 'vectors': result, 'reservedDiagnostics': diagnostics}, indent=2)+'\n')
