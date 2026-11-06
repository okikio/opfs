"""Native bzip2/Python bz2 producers and full-byte Python/native/7zz consumers; never imports OPFS."""
import argparse
import base64
import bz2
import hashlib
import json
import pathlib
import random
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--bzip', default='/usr/bin/bzip2')
parser.add_argument('--seven', default='/opt/homebrew/bin/7zz')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()


def command(argv, **options):
    return subprocess.run(argv, capture_output=True, timeout=30, **options)


def encoded(body):
    return base64.b64encode(body).decode()


version = command([args.bzip, '--version'], input=b'').stderr.decode()
seven = command([args.seven, 'i']).stdout.decode()
rng = random.Random(50519)
random_body = bytes(rng.randrange(256) for _ in range(210000))
inputs = [('empty', b'', 9), ('binary', bytes(range(256)) * 7, 9),
          ('multiblock', random_body, 1), ('long-run', b'A' * 2000000, 1),
          ('run-boundaries', b''.join(bytes([i]) * n for i in range(32) for n in [1, 2, 3, 4, 5, 254, 255, 256, 257, 258, 259, 260]), 1)]
inputs += [('level-' + str(level), b'All nine native header levels.\0' * 17, level) for level in range(1, 10)]
fixtures = []
diagnostics = []
with tempfile.TemporaryDirectory(prefix='opfs-native-bzip-') as directory:
    root = pathlib.Path(directory)
    for index, (name, body, level) in enumerate(inputs):
        producer = 'native-bzip2' if index % 2 == 0 else 'Python-bz2'
        if producer == 'native-bzip2':
            produced = command([args.bzip, '-' + str(level), '-c'], input=body)
            assert produced.returncode == 0, produced.stderr
            packed = produced.stdout
        else:
            packed = bz2.compress(body, compresslevel=level)
        assert bz2.decompress(packed) == body
        native = command([args.bzip, '-d', '-c'], input=packed)
        assert native.returncode == 0 and native.stdout == body
        path = root / (name + '.bz2')
        path.write_bytes(packed)
        consumer = command([args.seven, 'x', '-so', str(path)])
        assert consumer.returncode == 0 and consumer.stdout == body, (name, consumer.stderr)
        fixtures.append(dict(name=name, level=level, producer=producer, packed=encoded(packed), body=encoded(body),
                             sha256=hashlib.sha256(packed).hexdigest(), nativeExit=native.returncode,
                             sevenExit=consumer.returncode, sevenStderr=consumer.stderr.decode()))
        if name == 'binary':
            bits = ''.join(format(value, '08b') for value in packed)
            end = bits.rfind(format(0x177245385090, '048b')) + 80
            padding = len(bits) - end
            assert 0 < padding < 8
            altered = packed[:-1] + bytes([packed[-1] | ((1 << padding) - 1)])
            assert bz2.decompress(altered) == body
            native = command([args.bzip, '-d', '-c'], input=altered)
            assert native.returncode == 0 and native.stdout == body
            path.write_bytes(altered)
            consumer = command([args.seven, 'x', '-so', str(path)])
            assert consumer.returncode != 0 and consumer.stdout == body
            diagnostics.append(dict(name='nonzero-padding', packed=encoded(altered), paddingBits=padding,
                                    sha256=hashlib.sha256(altered).hexdigest(), nativeExit=native.returncode,
                                    sevenExit=consumer.returncode, sevenStderr=consumer.stderr.decode(),
                                    sevenFullBytesMatch=consumer.stdout == body))
receipt = dict(nativeVersion=version, python=sys.version, sevenVersion=seven,
               producerCommands=['bzip2 -LEVEL -c', 'Python bz2.compress(body, compresslevel=LEVEL)'],
               consumerCommands=['bzip2 -d -c', 'Python bz2.decompress', '7zz x -so fixture.bz2'],
               fixtures=fixtures, diagnostics=diagnostics)
pathlib.Path(args.output).write_text(json.dumps(receipt, indent=2) + '\n')
