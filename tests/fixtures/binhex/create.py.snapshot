"""Authored reciprocal macutils/Convert::BinHex fixture producer. No candidate imports."""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import resource
import subprocess
import sys
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--harness', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
records = []
CAP = 2 * 1024 * 1024

def limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (CAP, CAP))

def run(argv, cwd, required=True):
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        result = subprocess.run(argv, cwd=cwd, stdout=stdout, stderr=stderr, timeout=60, preexec_fn=limit)
        stdout.seek(0); stderr.seek(0)
        out, err = stdout.read(CAP + 1), stderr.read(CAP + 1)
    if len(out) > CAP or len(err) > CAP:
        raise RuntimeError('native diagnostic exceeds cap')
    records.append(dict(argv=argv, code=result.returncode, stdout=out.decode('utf-8', 'replace'), stderr=err.decode('utf-8', 'replace')))
    if required and result.returncode:
        raise RuntimeError(json.dumps(records[-1]))
    return out

def blob(value):
    return dict(base64=base64.b64encode(value).decode(), bytes=len(value), sha256=hashlib.sha256(value).hexdigest())

with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    version = run(['/usr/bin/dpkg-query', '-W', '-f=${Package}=${Version} ${Architecture}\n', 'macutils', 'libconvert-binhex-perl', 'perl'], root).decode()
    for tool in ['/usr/bin/binhex', '/usr/bin/hexbin']:
        run([tool, '-V'], root)
        run([tool, '-H'], root)
    perl_version = run(['/usr/bin/perl', '-MConvert::BinHex', '-e', 'print "$Convert::BinHex::VERSION\\n"'], root).decode()
    payloads = [
        ('empty', b'', b''), ('data', b'123456789', b''), ('rsrc', b'', b'123456789'),
        ('forks', bytes(range(256)) * 3, b'resource' * 13),
        ('runs', b'\x90' * 257 + b'Q' * 511, b'\x00' * 513),
        ('many', bytes((index * 17 + index // 257) & 255 for index in range(65537)), b'\x90\x00\x90' * 33),
    ] + [(f'tail{n}', bytes(range(n)), b'Z' * (n % 5)) for n in range(1, 10)]
    nested = io.BytesIO()
    nested_original = b'Original nested ZIP member bytes.'
    with zipfile.ZipFile(nested, 'w', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr('inside.txt', nested_original)
    payloads.append(('nested', nested.getvalue(), b'Preserved nested resource fork.'))
    fixtures = []
    for case, data, rsrc in payloads:
        folder = root / case; folder.mkdir()
        name = case + '.bin'
        d = folder / 'seed.data'; r = folder / 'seed.rsrc'; info = folder / 'seed.info'
        d.write_bytes(data); r.write_bytes(rsrc)
        header = bytearray(128)
        encoded_name = name.encode('ascii')
        header[1] = len(encoded_name); header[2:2 + len(encoded_name)] = encoded_name
        header[65:69] = b'TEST'; header[69:73] = b'OPFS'; header[73:75] = b'\x80\x00'
        header[83:87] = len(data).to_bytes(4, 'big'); header[87:91] = len(rsrc).to_bytes(4, 'big')
        info.write_bytes(header)
        c_encoded = run(['/usr/bin/binhex', str(info)], folder)
        c_file = folder / 'native.hqx'; c_file.write_bytes(c_encoded)
        p_file = folder / 'perl.hqx'
        run(['/usr/bin/perl', args.harness, 'encode', str(p_file), str(d), str(r), name], folder)
        for producer, file in [('macutils', c_file), ('perl', p_file)]:
            output = folder / (producer + '-c'); output.mkdir()
            run(['/usr/bin/hexbin', '-3', str(file)], output)
            expected = {name + '.info', name + '.data', name + '.rsrc'}
            actual = {path.name for path in output.iterdir()}
            if actual != expected:
                raise RuntimeError(f'unexpected extracted paths: {actual}, expected {expected}')
            if (output / (name + '.data')).read_bytes() != data or (output / (name + '.rsrc')).read_bytes() != rsrc:
                raise RuntimeError('macutils fork mismatch')
            pd = folder / (producer + '.data'); pr = folder / (producer + '.rsrc')
            metadata = run(['/usr/bin/perl', args.harness, 'decode', str(file), str(pd), str(pr)], folder).decode().strip()
            if metadata != f'{name}:TEST:OPFS:32768' or pd.read_bytes() != data or pr.read_bytes() != rsrc:
                raise RuntimeError('Perl fork/metadata mismatch')
            # The C decoder's CRC checks are separate from the Perl byte oracle.
            fixtures.append(dict(case=case, producer=producer, name=name, archive=blob(file.read_bytes()), data=blob(data), resource=blob(rsrc), metadata=metadata))
    python_receipt = dict(version=sys.version, executable=sys.executable, sha256=hashlib.sha256(pathlib.Path(sys.executable).read_bytes()).hexdigest())
    result = dict(python=python_receipt, nestedOriginal=blob(nested_original), packages=version, perlModuleVersion=perl_version, fixtures=fixtures, commands=records,
                  scripts={path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [pathlib.Path(__file__), pathlib.Path(args.harness)]})
    pathlib.Path(args.output).write_text(json.dumps(result, separators=(',', ':')) + '\n')
