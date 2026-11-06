"""Independent ZIP bytes for the ArFS source-composition test; stdlib only."""
import base64
import hashlib
import io
import json
import platform
import sys
import zipfile

original = b"Selected member from an explicitly supplied ArFS data source.\n"
output = io.BytesIO()
info = zipfile.ZipInfo("preview.txt", (2026, 1, 1, 0, 0, 0))
info.compress_type = zipfile.ZIP_STORED
with zipfile.ZipFile(output, "w") as archive:
    archive.writestr(info, original)
wire = output.getvalue()
with zipfile.ZipFile(io.BytesIO(wire), "r") as archive:
    assert archive.read("preview.txt") == original
receipt = {
    "producer": "Python stdlib zipfile",
    "version": platform.python_version(),
    "wireBase64": base64.b64encode(wire).decode(),
    "sha256": hashlib.sha256(wire).hexdigest(),
    "name": "preview.txt",
    "originalBase64": base64.b64encode(original).decode(),
}
with open(sys.argv[1], "w", encoding="utf8") as target:
    json.dump(receipt, target, indent=2)
    target.write("\n")
