"""Independent stdlib SMTP MIME producer/consumer; no OPFS imports."""
import base64
import hashlib
import json
import platform
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path

root = EmailMessage(policy=policy.SMTP)
root['From'] = 'sender@example.invalid'
root['To'] = 'reader@example.invalid'
root['Date'] = 'Thu, 05 Nov 2026 00:00:00 +0000'
root['Subject'] = 'A café message'
root['Message-ID'] = '<fixture@example.invalid>'
root.set_content('Plain café body.\n', charset='utf-8', cte='quoted-printable')
root.add_alternative('<p>HTML preview stays inert.</p>\n', subtype='html', cte='base64')
root.set_boundary('independent-alternative')
root.add_attachment(bytes([0, 1, 2, 13, 10, 255]) + b'authored attachment', maintype='application', subtype='octet-stream', filename='café.bin', cte='base64')
root.set_boundary('independent-mixed')
root.get_payload(0).set_boundary('independent-alternative')
root.preamble = 'Independent preamble'
root.epilogue = 'Independent epilogue\r\n'
raw = root.as_bytes(policy=policy.SMTP)
parsed = BytesParser(policy=policy.default).parsebytes(raw)
assert not parsed.defects
oracles = []
for part in parsed.walk():
    assert not part.defects
    payload = None if part.is_multipart() else part.get_payload(decode=True)
    oracles.append({'type': part.get_content_type(), 'filename': part.get_filename(),
        'payloadBase64': None if payload is None else base64.b64encode(payload).decode()})
assert base64.b64decode(oracles[2]['payloadBase64']) == 'Plain café body.\r\n'.encode()
assert base64.b64decode(oracles[4]['payloadBase64']) == bytes([0, 1, 2, 13, 10, 255]) + b'authored attachment'
result = {'producer': 'CPython email.message.EmailMessage SMTP / email.parser.BytesParser',
    'python': platform.python_version(), 'sha256': hashlib.sha256(raw).hexdigest(),
    'base64': base64.b64encode(raw).decode(), 'parts': oracles}
Path(__file__).with_name('independent.json').write_text(json.dumps(result, indent=2) + '\n')
