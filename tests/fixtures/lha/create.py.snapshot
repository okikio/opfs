"""Genuine JLHA archives; Lhasa, 7zip and libarchive compare original member bytes.

This producer does not import the candidate reader. Signed distro tools are test-only.
Run in a bounded disposable container after reviewing the recipe and exact base ID.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import tempfile


def run(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'{args!r} exited {result.returncode}\nstdout={result.stdout!r}\nstderr={result.stderr!r}')
    return result.stdout


def encoded(data):
    return {'base64': base64.b64encode(data).decode('ascii'), 'sha256': hashlib.sha256(data).hexdigest()}


parser = argparse.ArgumentParser()
parser.add_argument('--producer', default='/usr/bin/jlha')
parser.add_argument('--lhasa', default='/usr/bin/lhasa')
parser.add_argument('--seven', default='/usr/bin/7zz')
parser.add_argument('--bsdtar', default='/usr/bin/bsdtar')
parser.add_argument('--output', required=True)
args = parser.parse_args()
packages = run(['dpkg-query', '-W', '-f=${Package}=${Version}\n', 'jlha-utils', 'libjlha-java', 'lhasa', '7zip', 'libarchive-tools', 'default-jre-headless']).decode()
# ASCII names isolate wire/header interoperability from tool-specific filename encoding.
payloads = {'empty.bin': b'', 'tiny.txt': b'123456789', 'odd.bin': bytes(range(251)),
            'many.bin': bytes((i * 37 + i // 257) % 256 for i in range(230017)),
            'sub/nested.txt': b'owned native archive fixture\n',
            'sub/' + 'long-name-' * 9 + '.txt': b'long header extension name\n'}
fixtures = []
with tempfile.TemporaryDirectory(prefix='opfs-lha-') as temporary:
    root = pathlib.Path(temporary)
    for name, data in payloads.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    for level in (0, 1, 2):
        selected = dict(payloads)
        if level == 0:
            # Exact installed JLHA writer admits at most 100 header bytes,
            # including 24 fixed/CRC bytes. This is not the LHA format limit.
            long_name = 'sub/' + 'long-name-' * 9 + '.txt'
            short_name = 'sub/' + 'long-name-' * 5 + '.txt'
            selected[short_name] = selected.pop(long_name)
            (root / short_name).write_bytes(selected[short_name])
            assert len(short_name.encode('ascii')) == 58
        archive = root / f'level{level}.lzh'
        producer_command = [args.producer, f'az{level}', str(archive), *selected.keys()]
        receipt = run(producer_command, root)
        wire = archive.read_bytes()
        assert wire[2:7] == b'-lh0-' and wire[20] == level, (level, wire[:32])
        assert wire[-1:] == b'\0', 'producer omitted the single-byte archive terminator'
        consumers = []
        for tool, command in [
            ('jlha', [args.producer, 'xqw={destination}', str(archive)]),
            ('lhasa', [args.lhasa, 'xqw={destination}', str(archive)]),
            ('7zip', [args.seven, 'x', '-y', '-o{destination}', str(archive)]),
            ('libarchive', [args.bsdtar, '-xf', str(archive), '-C', '{destination}']),
        ]:
            # Only authored ASCII names enter these native test tools. No user
            # archive or candidate output is extracted by this producer.
            for name in selected:
                assert name.isascii() and not name.startswith('/')
                assert all(part not in ('', '.', '..') for part in name.split('/'))
            destination = root / f'extracted-{level}-{tool}'
            destination.mkdir()
            command = [part.replace('{destination}', str(destination)) for part in command]
            diagnostic = run(command, root)
            files = {}
            for path in destination.rglob('*'):
                assert not path.is_symlink(), (tool, path)
                if path.is_file():
                    files[path.relative_to(destination).as_posix()] = path.read_bytes()
                else:
                    assert path.is_dir(), (tool, path)
            assert set(files) == set(selected), (level, tool, sorted(files), sorted(selected))
            for name, expected in selected.items():
                assert files[name] == expected, (level, name, tool)
            consumers.append({'tool': tool, 'command': command,
                              'stdout': diagnostic.decode('utf-8', errors='backslashreplace'),
                              'payloadSha256': {name: hashlib.sha256(body).hexdigest() for name, body in files.items()}})
        fixtures.append({'level': level, 'command': producer_command, 'producerOutput': receipt.decode('utf-8', errors='backslashreplace'),
                         'consumers': consumers, 'archive': encoded(wire), 'payloads': {name: encoded(data) for name, data in selected.items()}})
pathlib.Path(args.output).write_text(json.dumps({'packages': packages, 'producerScriptSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
                                               'fixtures': fixtures}, separators=(',', ':')))
