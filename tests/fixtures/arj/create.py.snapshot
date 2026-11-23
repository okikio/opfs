"""Create genuine ARJ files and compare every original byte with ARJ and 7zip.

Candidate reader code is absent. Only authored inert paths enter native extractors.
Execute offline in a reviewed 1 GiB/1 CPU/128-pid container, not in continuing CI.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import resource
import subprocess
import tempfile


def encoded(body):
    return {'base64': base64.b64encode(body).decode('ascii'),
            'sha256': hashlib.sha256(body).hexdigest()}


def run(command, cwd=None, expected=(0,)):
    # File-backed diagnostics avoid unbounded capture_output allocation. The
    # authored inputs, 1 MiB per-file limit and timeout also bound native outputs.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        def bounds():
            resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
        result = subprocess.run(command, cwd=cwd, stdout=stdout, stderr=stderr,
                                timeout=60, preexec_fn=bounds, check=False)
        stdout.seek(0)
        stderr.seek(0)
        out, err = stdout.read(1024 * 1024 + 1), stderr.read(1024 * 1024 + 1)
        if len(out) > 1024 * 1024 or len(err) > 1024 * 1024:
            raise RuntimeError(f'{command!r}: diagnostic limit exceeded')
        receipt = {'command': command, 'exit': result.returncode,
                   'stdout': out.decode('utf-8', errors='backslashreplace'),
                   'stderr': err.decode('utf-8', errors='backslashreplace')}
        if result.returncode not in expected:
            raise RuntimeError(json.dumps(receipt))
        return receipt


parser = argparse.ArgumentParser()
parser.add_argument('--arj', default='/usr/bin/arj')
parser.add_argument('--seven', default='/usr/bin/7zz')
parser.add_argument('--output', required=True)
args = parser.parse_args()
packages = run(['dpkg-query', '-W', '-f=${Package}=${Version}\n', 'arj', '7zip', 'python3'])
# Help is diagnostic and may exit 1; actual creation/test/extraction must exit 0.
help_receipts = [run([args.arj], expected=(0, 1)), run([args.seven])]
payloads = {'empty.bin': b'', 'tiny.txt': b'123456789',
            'odd.bin': bytes(range(251)),
            'many.bin': bytes((i * 37 + i // 257) % 256 for i in range(65537)),
            'sub/nested.txt': b'ARJ selected bytes remain exact.\r\n\x00\xff'}
fixtures = []
with tempfile.TemporaryDirectory(prefix='opfs-arj-') as temporary:
    root = pathlib.Path(temporary)
    inputs = root / 'inputs'
    inputs.mkdir()
    for name, body in payloads.items():
        assert name.isascii() and not name.startswith('/')
        assert all(part not in ('', '.', '..') for part in name.split('/'))
        path = inputs / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    (inputs / 'emptydir').mkdir()
    archive_comment = root / 'archive-comment.txt'
    file_comment = root / 'file-comment.txt'
    archive_comment.write_bytes(b'Authored archive comment.\r\n')
    file_comment.write_bytes(b'Authored member comment.\r\n')
    for identifier, method, extra in [('stored', 0, False), ('compressed', 1, False), ('comments-directories', 0, True)]:
        archive = root / f'{identifier}.arj'
        # Pinned upstream resource/en/arj.1 documents -a1 (include directories),
        # -zFILE (archive comment), -jzFILE (member comment). Actual bytes and
        # command output remain authoritative; this does not suppress extensions.
        switches = ['-a1', '-z' + str(archive_comment)] if extra else []
        # Native literal directories are expanded to their contents. A literal argv
        # wildcard selects the directory itself; Python never invokes a shell.
        selected = [*payloads, *(['emptydi?'] if extra else [])]
        producer = run([args.arj, 'a', f'-m{method}', '-y', *switches, str(archive), *selected], inputs)
        # Member comments are applied by native command c, not by add.
        comment_receipt = (run([args.arj, 'c', '-y', '-jz' + str(file_comment), str(archive), 'tiny.txt'], inputs)
                           if extra else None)
        wire = archive.read_bytes()
        assert len(wire) < 1024 * 1024 and wire[:2] == b'\x60\xea'
        test_receipt = run([args.arj, 't', str(archive)])
        consumers = []
        for tool in ('arj', '7zip'):
            destination = root / f'extract-{identifier}-{tool}'
            destination.mkdir()
            command = ([args.arj, 'x', '-y', str(archive), str(destination) + '/'] if tool == 'arj'
                       else [args.seven, 'x', '-y', '-o' + str(destination), str(archive)])
            extraction = run(command, root)
            found = {}
            directories = []
            for path in destination.rglob('*'):
                assert not path.is_symlink(), (tool, str(path))
                if path.is_file():
                    assert path.stat().st_size <= 1024 * 1024
                    found[path.relative_to(destination).as_posix()] = path.read_bytes()
                else:
                    assert path.is_dir(), (tool, str(path))
                    directories.append(path.relative_to(destination).as_posix())
            if extra:
                assert 'emptydir' in directories, (tool, directories)
            assert set(found) == set(payloads), (tool, sorted(found), sorted(payloads))
            for name, original in payloads.items():
                assert found[name] == original, (method, tool, name)
            consumers.append({'tool': tool, 'receipt': extraction,
                              'payloadSha256': {name: hashlib.sha256(body).hexdigest() for name, body in found.items()}})
        fixtures.append({'id': identifier, 'method': method, 'directories': ['emptydir'] if extra else [],
                         'archiveComment': 'Authored archive comment.\r\n' if extra else '',
                         'fileComments': {'tiny.txt': 'Authored member comment.\r\n'} if extra else {},
                         'commentReceipt': comment_receipt,
                         'archive': encoded(wire), 'producer': producer,
                         'test': test_receipt, 'consumers': consumers,
                         'payloads': {name: encoded(body) for name, body in payloads.items()}})
result = {'packages': packages, 'help': help_receipts,
          'producerScriptSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          'fixtures': fixtures}
pathlib.Path(args.output).write_text(json.dumps(result, separators=(',', ':')))
