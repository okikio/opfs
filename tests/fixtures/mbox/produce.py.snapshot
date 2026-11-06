"""Independent Python mboxo producer/consumer plus Git mboxrd consumer proof.
Run from the repository root: python3 tests/fixtures/mbox/produce.py
Only trusted authored messages are passed to mailbox; no downloaded mail is opened.
"""
import base64
import hashlib
import json
import mailbox
import pathlib
import platform
import subprocess
import tempfile

root = pathlib.Path(__file__).parent
messages = [
    b'Subject: quotes\nMessage-ID: <same>\nContent-Type: text/plain\n\nFrom body\n>From original\n>>From original twice\nlast\n\n',
    b'Subject: attachment\nMessage-ID: <same>\nContent-Type: application/octet-stream\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename="test.bin"\n\nAAECA/8=\n',
]
def b64(value):
    return base64.b64encode(value).decode('ascii')
def record(value):
    return {'base64': b64(value), 'sha256': hashlib.sha256(value).hexdigest()}
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'python.mbox'
    box = mailbox.mbox(str(path))
    for original in messages:
        message = mailbox.mboxMessage(original)
        message.set_unixfrom('From test@example.test Thu Jan  1 00:00:00 1970')
        box.add(message)
    box.flush()
    python_oracle = [b64(box.get_bytes(key)) for key in box.iterkeys()]
    box.close()
    mboxo = path.read_bytes()
    # Authored encoder, NOT an independent mboxrd producer. Git below is the independent consumer.
    rd = bytearray()
    for original in messages:
        rd.extend(b'From test@example.test Thu Jan  1 00:00:00 1970\n')
        for line in original.splitlines(keepends=True):
            if line.lstrip(b'>').startswith(b'From '):
                rd.extend(b'>')
            rd.extend(line)
        rd.extend(b'\n')
    path.write_bytes(rd)
    output = pathlib.Path(directory) / 'split'
    output.mkdir()
    subprocess.run(['git', 'mailsplit', '--mboxrd', '-o' + str(output), str(path)], check=True, capture_output=True)
    git_oracle = [b64(file.read_bytes()) for file in sorted(output.iterdir())]
    fixture = {'python': platform.python_version(), 'git': subprocess.check_output(['git', '--version'], text=True).strip(), 'original': list(map(b64, messages)), 'mboxo': record(mboxo), 'pythonStored': python_oracle, 'mboxrd': record(bytes(rd)), 'gitSplit': git_oracle}
    (root / 'independent.json').write_text(json.dumps(fixture, indent=2) + '\n')
