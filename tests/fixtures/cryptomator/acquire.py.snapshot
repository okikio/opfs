"""Acquire released test tools without executing jars, Maven, or upstream setup scripts.

Review this file and the resulting receipts before approving the separate native
producer. Maven Central TLS and matching repository SHA-1 sidecars are acquisition
evidence, not an independently authenticated signing-key chain.
"""
import argparse
import hashlib
import json
import pathlib
import re
import urllib.parse
import urllib.request
import zipfile

ARTIFACTS = [
    ("org.cryptomator", "cryptolib", "2.4.0"),
    ("org.cryptomator", "siv-mode", "1.6.1"),
    ("org.bouncycastle", "bcprov-jdk18on", "1.80"),
    ("com.google.guava", "guava", "33.7.2-jre"),
    ("com.google.guava", "failureaccess", "1.0.3"),
    ("com.google.code.gson", "gson", "2.14.0"),
    ("org.slf4j", "slf4j-api", "2.0.20"),
]

class SameOrigin(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or parsed.netloc != "repo.maven.apache.org":
            raise ValueError("Cross-origin artifact redirect refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    target = pathlib.Path(args.output)
    target.mkdir(parents=True, exist_ok=True)
    receipt = []
    opener = urllib.request.build_opener(SameOrigin())
    license_total = 0
    total = 0
    for group, artifact, version in ARTIFACTS:
        base = f"https://repo.maven.apache.org/maven2/{group.replace('.', '/')}/{artifact}/{version}/{artifact}-{version}"
        for suffix in (".pom", ".jar"):
            url = base + suffix
            with opener.open(url, timeout=60) as response:
                body = response.read(16 * 1024 * 1024 + 1)
            if len(body) > 16 * 1024 * 1024:
                raise ValueError("Artifact exceeds acquisition byte limit")
            total += len(body)
            if total > 64 * 1024 * 1024:
                raise ValueError("Aggregate acquisition byte limit exceeded")
            with opener.open(url + ".sha1", timeout=30) as response:
                expected = response.read(512).decode("ascii").strip().split()[0]
            if not re.fullmatch(r"[0-9A-Fa-f]{40}", expected):
                raise ValueError("Malformed repository SHA-1 sidecar")
            assert hashlib.sha1(body).hexdigest() == expected.lower(), url
            path = target / f"{artifact}-{version}{suffix}"
            path.write_bytes(body)
            item = dict(url=url, bytes=len(body), sha256=hashlib.sha256(body).hexdigest(), repositorySha1=expected)
            if suffix == ".jar":
                with zipfile.ZipFile(path) as jar:
                    licenses = []
                    classes = {}
                    entries = jar.infolist()
                    if len(entries) > 20000:
                        raise ValueError("Too many artifact ZIP entries")
                    jar_licenses = 0
                    for info in entries:
                        upper = info.filename.upper()
                        if upper.startswith("META-INF/") and ("LICENSE" in upper or "NOTICE" in upper):
                            if info.file_size > 1024 * 1024 or len(licenses) >= 64:
                                raise ValueError("Embedded license byte/count limit exceeded")
                            jar_licenses += info.file_size
                            license_total += info.file_size
                            if jar_licenses > 2 * 1024 * 1024 or license_total > 8 * 1024 * 1024:
                                raise ValueError("Aggregate embedded license bytes exceeded")
                            text = jar.read(info)
                            licenses.append(dict(path=info.filename, sha256=hashlib.sha256(text).hexdigest(), text=text.decode("utf8", errors="replace")))
                        if info.filename.endswith(".class"):
                            with jar.open(info) as stream:
                                prefix = stream.read(8)
                            if len(prefix) != 8 or prefix[:4] != b"\xca\xfe\xba\xbe":
                                raise ValueError("Malformed Java class prefix")
                            major = int.from_bytes(prefix[6:8], "big")
                            section = "base"
                            if info.filename.startswith("META-INF/versions/"):
                                section = "release-" + info.filename.split("/")[2]
                            if section == "base" and major > 61:
                                raise ValueError("Base classes require a JVM newer than approved Java 17")
                            classes.setdefault(section, {})[str(major)] = classes.setdefault(section, {}).get(str(major), 0) + 1
                    item["embeddedLicenses"] = licenses
                    item["classMajorCounts"] = classes
                    item["multiReleaseManifest"] = jar.read("META-INF/MANIFEST.MF").decode("utf8", errors="replace") if "META-INF/MANIFEST.MF" in jar.namelist() else None
            receipt.append(item)
    (target / "acquisition.json").write_text(json.dumps(dict(artifacts=receipt), indent=2) + "\n")

if __name__ == "__main__":
    main()
