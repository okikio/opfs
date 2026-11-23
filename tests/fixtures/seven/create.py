"""Independent 7-Zip producer and libarchive consumer for bounded profile tests.

python3 tests/fixtures/seven/create.py --seven /usr/bin/7zz --bsdtar /usr/bin/bsdtar
Original inputs supply full payload oracles. Passwords below are public test data.
No OPFS code is imported. Encoded/encrypted profiles are rejection fixtures.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import struct
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--seven', default='7zz')
parser.add_argument('--bsdtar', default='bsdtar')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()

def command(argv, **kwargs):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=20, **kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'command': argv, 'exitCode': result.returncode,
                                      'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}))
    return result

producer = command([args.seven]).stdout.decode(errors='replace').splitlines()[:5]
consumer = command([args.bsdtar, '--version']).stdout.decode().strip()
profiles = {
    'copy': ['-m0=Copy', '-ms=off', '-mhc=off'],
    'lzma2': ['-m0=LZMA2', '-ms=off', '-mhc=off'],
    'solid': ['-m0=LZMA2', '-ms=on', '-mhc=off'],
    'encoded': ['-m0=Copy', '-ms=off', '-mhc=on'],
    'encrypted': ['-m0=Copy', '-ms=off', '-mhc=off', '-pfixture-password', '-mhe=off'],
    'encrypted-header': ['-m0=Copy', '-ms=off', '-mhc=on', '-pfixture-password', '-mhe=on'],
}
result = {}
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    inputs = root / 'inputs'; inputs.mkdir(); (inputs / 'folder').mkdir()
    bodies = {'folder/first.bin': bytes(range(73)),
              'large.bin': bytes((i * 31 + 17) % 251 for i in range(131072)),
              'last.bin': b'late\x00binary\xffpayload', 'caf\u00e9.txt': b'Unicode name payload',
              '\U0001f680.txt': b'Surrogate pair name'}
    bodies.update({'empty-%02d' % i: b'' for i in range(10)})
    for name, body in bodies.items():
        path = inputs / name; path.write_bytes(body); os.chmod(path, 0o644); os.utime(path, (946684800, 946684800))
    os.chmod(inputs / 'folder', 0o755); os.utime(inputs / 'folder', (946684800, 946684800))
    names = ['folder', *[name for name in bodies if not name.startswith('folder/')]]
    expected = [{'name': 'folder', 'kind': 'directory', 'body': ''}] + [
        {'name': name, 'kind': 'file', 'body': base64.b64encode(body).decode()} for name, body in bodies.items()]
    for profile, flags in profiles.items():
        archive = root / (profile + '.7z')
        argv = [args.seven, 'a', '-t7z', *flags, '-mtm=off', '-mtc=off', '-mta=off', str(archive), *names]
        command(argv, cwd=inputs)
        encoded = archive.read_bytes()
        offset = struct.unpack_from('<Q', encoded, 12)[0]
        header_size = struct.unpack_from('<Q', encoded, 20)[0]
        header_tag = encoded[32 + offset] if header_size else None
        destination = root / ('extract-' + profile); destination.mkdir()
        checked = subprocess.run([args.bsdtar, '-xf', str(archive), '-C', str(destination)], stdin=subprocess.DEVNULL,
                                 capture_output=True, timeout=20)
        supported_consumer = profile not in ['encrypted', 'encrypted-header']
        if supported_consumer:
            if checked.returncode:
                raise RuntimeError(json.dumps({'profile': profile, 'consumerStderr': checked.stderr.decode(errors='replace')}))
            for name, body in bodies.items(): assert (destination / name).read_bytes() == body, (profile, name)
        result[profile] = {'producer': producer, 'consumer': consumer,
                           'command': [args.seven, 'a', '-t7z', *flags, '-mtm=off', '-mtc=off', '-mta=off', profile+'.7z', *names],
                           'consumerExitCode': checked.returncode, 'consumerStderr': checked.stderr.decode(errors='replace'),
                           'independentPayloadVerified': supported_consumer,
                           'nextHeaderTag': header_tag, 'sha256': hashlib.sha256(encoded).hexdigest(),
                           'archive': base64.b64encode(encoded).decode(), 'entries': expected}
pathlib.Path(args.output).write_text(json.dumps(result, indent=2)+'\n')
