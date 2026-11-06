"""Authored QCOW2 original-raw/QEMU readback producer; never imports candidate code."""
import argparse
import base64
import hashlib
import json
import pathlib
import resource
import struct
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
CAP = 8 * 1024 * 1024
commands = []
diagnostic_bytes = 0
fixture_bytes = 0

def limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (CAP, CAP))

def run(argv, cwd):
    """Keep bounded native diagnostics even on the first failing fixed-input command."""
    global diagnostic_bytes
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        result = subprocess.run(argv, cwd=cwd, stdout=stdout, stderr=stderr, timeout=60, preexec_fn=limit)
        stdout.seek(0)
        stderr.seek(0)
        out, err = stdout.read(CAP + 1), stderr.read(CAP + 1)
    if len(out) > CAP or len(err) > CAP:
        raise RuntimeError('native diagnostic exceeds its bound')
    diagnostic_bytes += len(out) + len(err)
    if diagnostic_bytes > 4 * 1024**2:
        raise RuntimeError('cumulative native diagnostics exceed 4 MiB')
    record = dict(argv=argv, code=result.returncode, stdout=out.decode('utf-8', 'replace'), stderr=err.decode('utf-8', 'replace'))
    commands.append(record)
    print(json.dumps(record), flush=True)
    if result.returncode:
        raise RuntimeError('native command failed; complete diagnostic printed above')
    return out

def blob(value):
    global fixture_bytes
    if len(value) > CAP:
        raise RuntimeError('fixture file exceeds its bound')
    encoded = base64.b64encode(value).decode()
    fixture_bytes += len(value) + len(encoded)
    if fixture_bytes > 16 * 1024**2:
        raise RuntimeError('original plus encoded fixture aggregate exceeds 16 MiB')
    return dict(base64=encoded, bytes=len(value), sha256=hashlib.sha256(value).hexdigest())

def observed(image, offsets):
    """Record the actual producer's selected wire entries, not candidate output."""
    data = image.read_bytes()
    bits = struct.unpack_from('>I', data, 20)[0]
    cluster = 1 << bits
    l1 = struct.unpack_from('>Q', data, 40)[0]
    mask = 0x00fffffffffffe00
    entries = []
    for offset in offsets:
        guest = offset // cluster
        l2 = struct.unpack_from('>Q', data, l1 + (guest // (cluster // 8)) * 8)[0] & mask
        descriptor = struct.unpack_from('>Q', data, l2 + (guest % (cluster // 8)) * 8)[0] if l2 else 0
        entries.append(dict(guestOffset=offset, descriptor=f'{descriptor:016x}', explicitZero=bool(descriptor & 1) if not descriptor & (1 << 62) else None, compressed=bool(descriptor & (1 << 62)), sourceOffset=descriptor & mask if not descriptor & (1 << 62) else None))
    version = struct.unpack_from('>I', data, 4)[0]
    return dict(version=version, clusterSize=cluster, headerLength=72 if version == 2 else struct.unpack_from('>I', data, 100)[0], selectedEntries=entries)

with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    version = run(['/usr/bin/qemu-img', '--version'], root).decode()
    io_version = run(['/usr/bin/qemu-io', '--version'], root).decode()
    packages = run(['/usr/bin/dpkg-query', '-W', '-f=${Package}=${Version} ${Architecture}\n', 'qemu-utils'], root).decode()
    # The fixture uses pattern read/write commands only after retaining real help.
    run(['/usr/bin/qemu-io', '-c', 'help write'], root)
    run(['/usr/bin/qemu-io', '-c', 'help read'], root)
    fixtures = []
    for compat in ['0.10', '1.1']:
        for cluster in [512, 4096, 65536]:
            folder = root / f'compat{compat}-cluster{cluster}'
            folder.mkdir()
            length = 66048 if cluster == 512 else cluster * 4
            original = bytearray(length)
            # Start, an absent interior cluster, repeated and nonconstant regions,
            # and a final extent crossing the second L1 mapping at cluster 512.
            for index in range(min(cluster, length)):
                original[index] = (index * 17 + index // 257) & 255
            for index in range(cluster * 2, min(cluster * 3, length)):
                original[index] = 0xa5
            original[-513:] = bytes((index * 19 + 7) & 255 for index in range(513))
            raw = folder / 'original.raw'
            image = folder / 'native.qcow2'
            raw.write_bytes(original)
            run(['/usr/bin/qemu-img', 'convert', '-f', 'raw', '-O', 'qcow2', '-o', f'compat={compat},cluster_size={cluster},lazy_refcounts=off', str(raw), str(image)], folder)
            output = folder / 'readback.raw'
            run(['/usr/bin/qemu-img', 'convert', '-f', 'qcow2', '-O', 'raw', str(image), str(output)], folder)
            if output.read_bytes() != original:
                raise RuntimeError('QEMU raw readback differs from original full bytes')
            info = json.loads(run(['/usr/bin/qemu-img', 'info', '--output=json', '-f', 'qcow2', str(image)], folder))
            mapping = json.loads(run(['/usr/bin/qemu-img', 'map', '--output=json', '-f', 'qcow2', str(image)], folder))
            check = json.loads(run(['/usr/bin/qemu-img', 'check', '--output=json', '-f', 'qcow2', str(image)], folder))
            run(['/usr/bin/qemu-io', '-r', '-f', 'qcow2', '-c', f'read -P 0 {cluster} {cluster}', str(image)], folder)
            fixtures.append(dict(case=folder.name, image=blob(image.read_bytes()), original=blob(original), observed=observed(image, [0, cluster, cluster * 2, length - 512]), info=info, mapping=mapping, check=check))
    # Genuine all-hole images exercise absent L1/L2 mappings in both versions.
    for compat in ['0.10', '1.1']:
        folder = root / f'holes-{compat}'
        folder.mkdir()
        image = folder / 'native.qcow2'
        run(['/usr/bin/qemu-img', 'create', '-f', 'qcow2', '-o', f'compat={compat},cluster_size=4096,lazy_refcounts=off', str(image), '16384'], folder)
        output = folder / 'readback.raw'
        run(['/usr/bin/qemu-img', 'convert', '-f', 'qcow2', '-O', 'raw', str(image), str(output)], folder)
        if output.read_bytes() != bytes(16384):
            raise RuntimeError('all-hole original mismatch')
        fixtures.append(dict(case=folder.name, image=blob(image.read_bytes()), original=blob(bytes(16384)), observed=observed(image, [0, 4096, 12288])))
    # Do not assume that zeroing retains preallocation: actual descriptor evidence
    # is stored, and a missing explicit-zero bit is a diagnostic to review.
    folder = root / 'zero-v3'
    folder.mkdir()
    image = folder / 'native.qcow2'
    run(['/usr/bin/qemu-img', 'create', '-f', 'qcow2', '-o', 'compat=1.1,cluster_size=4096,lazy_refcounts=off', str(image), '16384'], folder)
    run(['/usr/bin/qemu-io', '-f', 'qcow2', '-c', 'write -P 165 4096 4096', '-c', 'write -z 4096 4096', str(image)], folder)
    output = folder / 'readback.raw'
    run(['/usr/bin/qemu-img', 'convert', '-f', 'qcow2', '-O', 'raw', str(image), str(output)], folder)
    if output.read_bytes() != bytes(16384):
        raise RuntimeError('zero original mismatch')
    run(['/usr/bin/qemu-io', '-r', '-f', 'qcow2', '-c', 'read -P 0 4096 4096', str(image)], folder)
    fixtures.append(dict(case=folder.name, image=blob(image.read_bytes()), original=blob(bytes(16384)), observed=observed(image, [0, 4096, 8192])))
    # Native unsupported profiles are preserved unchanged. They are valid QEMU
    # objects, not authored bit mutations disguised as genuine producers.
    controls = []
    control = root / 'controls'
    control.mkdir()
    original = bytes([0xa5]) * 65536
    raw = control / 'original.raw'
    raw.write_bytes(original)
    compressed = control / 'compressed.qcow2'
    run(['/usr/bin/qemu-img', 'convert', '-c', '-f', 'raw', '-O', 'qcow2', '-o', 'cluster_size=4096,compat=1.1', str(raw), str(compressed)], control)
    backing = control / 'backing.qcow2'
    run(['/usr/bin/qemu-img', 'create', '-f', 'qcow2', '-F', 'raw', '-b', str(raw), str(backing)], control)
    snapshot = control / 'snapshot.qcow2'
    run(['/usr/bin/qemu-img', 'convert', '-f', 'raw', '-O', 'qcow2', str(raw), str(snapshot)], control)
    run(['/usr/bin/qemu-img', 'snapshot', '-c', 'owned-native-snapshot', str(snapshot)], control)
    for name, image in [('compressed', compressed), ('backing', backing), ('snapshot', snapshot)]:
        output = control / (name + '.raw')
        run(['/usr/bin/qemu-img', 'convert', '-f', 'qcow2', '-O', 'raw', str(image), str(output)], control)
        if output.read_bytes() != original:
            raise RuntimeError('unsupported-profile native readback mismatch')
        controls.append(dict(case=name, image=blob(image.read_bytes()), original=blob(original), observed=observed(image, [0, 4096])))
    result = dict(qemuVersion=version, qemuIoVersion=io_version, packages=packages, python=dict(version=sys.version, executable=sys.executable), fixtures=fixtures, controls=controls, commands=commands,
                  limits=dict(fixtureOriginalAndEncodedBytes=fixture_bytes, maxFixtureOriginalAndEncodedBytes=16 * 1024**2, nativeDiagnosticBytes=diagnostic_bytes, maxNativeDiagnosticBytes=4 * 1024**2),
                  scripts={path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [pathlib.Path(__file__), pathlib.Path(__file__).with_name('acquire.sh'), pathlib.Path(__file__).with_name('acquire-run.py'), pathlib.Path(__file__).with_name('producer-run.py')]})
    serialized = (json.dumps(result, separators=(',', ':')) + '\n').encode('utf-8')
    if len(serialized) > 32 * 1024**2:
        raise RuntimeError('final fixture JSON exceeds 32 MiB')
    pathlib.Path(args.output).write_bytes(serialized)
