"""Generate genuine BagIt 1.0 files and independent validation/digest evidence.
Use the immutable upstream commit recorded below, not bagit 1.8 (which emits 0.97).
Reproduction instructions are in README.md. No source rewrites or fixture repair.
"""
import base64
import hashlib
import importlib.metadata
import json
import pathlib
import platform
import tempfile
import bagit

COMMIT = '4bd2713cedbe1f8e634567c20ef0dded9622011d'
output = pathlib.Path(__file__).parent / 'independent.json'
authored = {
    'empty.bin': b'',
    'binary.bin': bytes([0,1,2,3,255]),
    'nested/caf\u00e9 with space.txt': 'Preserved content\n'.encode(),
    'actual\nnewline.txt': b'An encoded newline filename.\n',
}
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory) / 'bag'
    root.mkdir()
    for name, value in authored.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value)
    bag = bagit.make_bag(str(root), {'Bagging-Date': '2026-11-05', 'Bag-Software-Agent': 'Independent pinned bagit-python fixture', 'Contact-Name': ['One', 'Two']}, checksums=['sha256','sha512'], processes=1)
    assert bag.version_info == (1,0), bag.version_info
    assert bag.validate(processes=1)
    files = []
    for path in sorted(root.rglob('*')):
        if path.is_file():
            value = path.read_bytes()
            files.append({'path': path.relative_to(root).as_posix(), 'base64': base64.b64encode(value).decode(), 'sha256': hashlib.sha256(value).hexdigest(), 'sha512': hashlib.sha512(value).hexdigest()})
    target = root / 'data/binary.bin'
    saved = target.read_bytes()
    target.write_bytes(b'tampered')
    tamper_rejected = not bag.is_valid(processes=1)
    target.write_bytes(saved)
    target.unlink()
    missing_rejected = not bag.is_valid(processes=1)
    target.write_bytes(saved)
    extra = root / 'data/extra'
    extra.write_bytes(b'extra')
    extra_rejected = not bag.is_valid(processes=1)
    extra.unlink()
    assert bag.validate(processes=1)
    source = pathlib.Path(bagit.__file__).read_bytes()
    percent_root = pathlib.Path(directory) / 'percent-limit'
    percent_root.mkdir()
    (percent_root / 'literal%0A.txt').write_bytes(b'Literal percent, not a newline name.\n')
    percent_bag = bagit.make_bag(str(percent_root), {'Bagging-Date': '2026-11-05', 'Bag-Software-Agent': 'Pinned producer percent limitation'}, checksums=['sha256'], processes=1)
    percent_limit = {'name': 'literal%0A.txt', 'validatorRejectedOwnOutput': not percent_bag.is_valid(processes=1), 'manifestBase64': base64.b64encode((percent_root / 'manifest-sha256.txt').read_bytes()).decode()}
    fixture = {'producerPercentLimitation': percent_limit, 'producerCommit': COMMIT, 'producerVersion': importlib.metadata.version('bagit'), 'producerSourceSha256': hashlib.sha256(source).hexdigest(), 'python': platform.python_version(), 'validation': {'genuine1': True, 'tamperRejected': tamper_rejected, 'missingRejected': missing_rejected, 'extraRejected': extra_rejected}, 'files': files}
    assert all(fixture['validation'].values())
    output.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + '\n')
