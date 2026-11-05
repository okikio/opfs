"""Reciprocal released Cryptomator cryptolib / PyCryptodome interoperability.

Run only after acquisition receipts and this authored harness are reviewed.
JWTs and archive contents are authored protocol inputs, not cryptolib-produced
configuration files. Headers/chunks/names are genuine released-library outputs.
Every original byte and name is checked in both directions; no candidate imports.
"""
import argparse
import base64
import hashlib
import hmac
import io
import json
import os
import pathlib
import resource
import subprocess
import tempfile
import zipfile
from Cryptodome.Cipher import AES
import Cryptodome


def run(args):
    # Authored inputs/paths only. Native stdout/stderr are files, not unbounded
    # pipes. Each child output file is capped at 8 MiB; diagnostics at 1 MiB.
    def bound_files():
        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        result = subprocess.run(args, stdout=stdout, stderr=stderr, timeout=120, preexec_fn=bound_files)
        stdout.seek(0)
        stderr.seek(0)
        out, err = stdout.read(1024 * 1024 + 1), stderr.read(1024 * 1024 + 1)
    if result.returncode or len(out) > 1024 * 1024 or len(err) > 1024 * 1024:
        print(out[:1024 * 1024].decode("utf8", errors="replace"), flush=True)
        print(err[:1024 * 1024].decode("utf8", errors="replace"), flush=True)
        raise subprocess.CalledProcessError(result.returncode or 1, args)
    return out


def b64(body):
    return base64.b64encode(body).decode("ascii")


def url(body):
    return base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")


def python_encrypt(body, key):
    nonce, content = os.urandom(12), os.urandom(32)
    cipher = AES.new(key[:32], AES.MODE_GCM, nonce=nonce, mac_len=16)
    payload, tag = cipher.encrypt_and_digest(b"\xff" * 8 + content)
    out = nonce + payload + tag
    for index, at in enumerate(range(0, len(body), 32768)):
        iv = os.urandom(12)
        cipher = AES.new(content, AES.MODE_GCM, nonce=iv, mac_len=16)
        cipher.update(index.to_bytes(8, "big") + nonce)
        payload, tag = cipher.encrypt_and_digest(body[at:at + 32768])
        out += iv + payload + tag
    return out


def python_decrypt(body, key):
    cipher = AES.new(key[:32], AES.MODE_GCM, nonce=body[:12], mac_len=16)
    header = cipher.decrypt_and_verify(body[12:52], body[52:68])
    assert header[:8] == b"\xff" * 8
    out = bytearray()
    for index, at in enumerate(range(68, len(body), 32796)):
        chunk = body[at:at + 32796]
        cipher = AES.new(header[8:], AES.MODE_GCM, nonce=chunk[:12], mac_len=16)
        cipher.update(index.to_bytes(8, "big") + body[:12])
        out.extend(cipher.decrypt_and_verify(chunk[12:-16], chunk[-16:]))
    return bytes(out)


def encrypt_name(name, parent, key):
    cipher = AES.new(key[32:] + key[:32], AES.MODE_SIV)
    cipher.update(parent)
    body, tag = cipher.encrypt_and_digest(name.encode("utf8"))
    return base64.urlsafe_b64encode(tag + body).decode("ascii") + ".c9r"


def decrypt_name(name, parent, key):
    wire = base64.urlsafe_b64decode(name[:-4])
    cipher = AES.new(key[32:] + key[:32], AES.MODE_SIV)
    cipher.update(parent)
    return cipher.decrypt_and_verify(wire[16:], wire[:16]).decode("utf8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    artifacts = pathlib.Path(args.artifacts)
    receipt = json.loads((artifacts / "acquisition.json").read_text())
    jars = []
    for item in receipt["artifacts"]:
        path = artifacts / item["url"].rsplit("/", 1)[-1]
        assert path.stat().st_size == item["bytes"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
        # Both cryptolib and siv-mode already relocate their BC runtime classes.
        # Keep the separately acquired optional BC artifact in receipts only.
        if path.suffix == ".jar" and not path.name.startswith("bcprov-"):
            jars.append(str(path))
    key = bytes(range(64))  # Fixed test key, never a credential.
    head = url(b'{"typ":"JWT","alg":"HS256","kid":"masterkeyfile:masterkey.cryptomator"}')
    payload = url(b'{"jti":"00000000-0000-0000-0000-000000000001","format":8,"cipherCombo":"SIV_GCM","shorteningThreshold":220}')
    signing = f"{head}.{payload}".encode("ascii")
    config = signing.decode("ascii") + "." + url(hmac.digest(key, signing, "sha256"))
    original_zip = io.BytesIO()
    with zipfile.ZipFile(original_zip, "w", zipfile.ZIP_STORED) as z:
        z.writestr("unrelated.bin", bytes((i * 29 + i // 31) & 255 for i in range(1048576)))
        z.writestr("selected.txt", b"authenticated nested archive preview\n")
    cases = [(f"length-{size}", bytes((i * 37 + i // 17) & 255 for i in range(size)), "report.bin", b"")
             for size in (0, 1, 15, 16, 17, 32767, 32768, 32769, 100003)]
    cases += [("unicode", b"unicode-name", "caf\u00e9-\u732b.txt", b"00000000-0000-0000-0000-000000000001"),
              ("bom-name", b"bom-name", "\ufeffliteral.txt", b""),
              ("nested-zip", original_zip.getvalue(), "archive.zip", b"")]
    cases += [(f"name-{size}", b"name-boundary", "n" * size, b"p" * size)
              for size in (1, 15, 16, 17, 31, 32, 33)]
    fixtures = []
    with tempfile.TemporaryDirectory(prefix="cryptomator-proof-") as directory:
        root = pathlib.Path(directory)
        classpath = os.pathsep.join(jars)
        run(["javac", "-J-Xmx256m", "-cp", classpath, "-d", str(root), args.source])
        classpath += os.pathsep + str(root)
        for label, original, name, parent in cases:
            case = root / label
            case.mkdir()
            (case / "key.bin").write_bytes(key)
            (case / "original.bin").write_bytes(original)
            (case / "name.txt").write_text(name, encoding="utf8")
            (case / "parent.bin").write_bytes(parent)
            run(["java", "-Xmx256m", "-cp", classpath, "Native", "encrypt", str(case)])
            cipher = (case / "cipher.bin").read_bytes()
            cipher_name = (case / "name.cipher").read_text(encoding="utf8")
            assert python_decrypt(cipher, key) == original
            assert decrypt_name(cipher_name, parent, key) == name
            python_cipher = python_encrypt(original, key)
            python_name = encrypt_name(name, parent, key)
            (case / "cipher.bin").write_bytes(python_cipher)
            (case / "name.cipher").write_text(python_name, encoding="utf8")
            run(["java", "-Xmx256m", "-cp", classpath, "Native", "decrypt", str(case)])
            assert (case / "native-decoded.bin").read_bytes() == original
            assert (case / "native-name.txt").read_text(encoding="utf8") == name
            fixtures.append(dict(id=label, original=b64(original), originalSha256=hashlib.sha256(original).hexdigest(),
                                 ciphertext=b64(cipher), ciphertextSha256=hashlib.sha256(cipher).hexdigest(),
                                 pythonCiphertext=b64(python_cipher), name=name, parent=parent.decode("ascii"),
                                 encryptedName=cipher_name, pythonEncryptedName=python_name))
    result = dict(key=b64(key), configuration=config, fixtures=fixtures, acquisition=receipt,
                  tools=dict(java=run(["java", "--version"]).decode("utf8", errors="replace"),
                             javac=run(["javac", "-version"]).decode("utf8", errors="replace"), pycryptodome=Cryptodome.__version__),
                  classpath=[pathlib.Path(path).name for path in jars],
                  scripts={path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in
                           (pathlib.Path(__file__), pathlib.Path(args.source), pathlib.Path(__file__).with_name("acquire.py"))})
    pathlib.Path(args.output).write_text(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n")
    print(json.dumps(dict(fixtures=len(fixtures), bytes=pathlib.Path(args.output).stat().st_size,
                         sha256=hashlib.sha256(pathlib.Path(args.output).read_bytes()).hexdigest())))


if __name__ == "__main__":
    main()
