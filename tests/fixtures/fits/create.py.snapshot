"""Authored Astropy/CFITSIO reciprocal producer. Only original inert fixtures are retained."""
import argparse, base64, hashlib, json, pathlib, subprocess, tempfile, sys
import numpy as np
from astropy.io import fits
import astropy

def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        print("Failed command: " + repr(args), file=sys.stderr)
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        result.check_returncode()
    return result
def packed(data):
    return {"base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    exe = root / "fits-native"
    run(["cc", args.source, "-lcfitsio", "-o", str(exe)])
    arrays = [np.arange(12, dtype=np.uint8).reshape(3, 4), np.array([-32768, -2, 0, 32767], dtype=np.int16),
              np.array([-2147483648, 2147483647], dtype=np.int32),
              np.array([-9007199254740993, 9007199254740993, 9223372036854775807], dtype=np.int64),
              np.array([0., -0., np.nan, np.inf, -np.inf, 1.25], dtype=np.float32),
              np.array([0., -0., np.nan, np.inf, -np.inf, 1.25], dtype=np.float64),
              np.zeros((0, 2), dtype=np.int16), np.arange(200000, dtype=np.int16)]
    hdus = [fits.PrimaryHDU(arrays[0])] + [fits.ImageHDU(a) for a in arrays[1:]]
    hdus[1].header["BSCALE"] = 2.0
    hdus[1].header["BZERO"] = 32768.0
    hdus[1].header["BLANK"] = -32768
    hdus[1].header["BUNIT"] = "adu"
    for n in range(50): hdus[0].header.add_comment("Authored long header card %d" % n)
    paths = []
    astropy_path = root / "astropy.fits"
    fits.HDUList(hdus).writeto(astropy_path, checksum=True)
    paths.append(("astropy", astropy_path))
    c_path = root / "cfitsio.fits"
    run([str(exe), "write", str(c_path), str(root)])
    paths.append(("cfitsio", c_path))
    fixtures = []
    for producer, path in paths:
        out = root / producer; out.mkdir()
        receipt = run([str(exe), "read", str(path), str(out)])
        images = []
        with fits.open(path, do_not_scale_image_data=True, uint=False, checksum=True) as opened:
            for index, hdu in enumerate(opened):
                array = hdu.data
                raw = b"" if array is None else array.astype(array.dtype.newbyteorder("="), copy=True).tobytes()
                independent = (out / (str(index) + ".bin")).read_bytes()
                assert independent == raw, (producer, index)
                assert hdu.verify_checksum() == 1 and hdu.verify_datasum() == 1
                physical = None
                if hdu.header["BITPIX"] != 64:
                    native_physical = (out / (str(index) + ".physical")).read_bytes()
                    stored = np.array([], dtype=np.float64) if array is None else array.reshape(-1)
                    missing = np.isnan(stored) if hdu.header["BITPIX"] < 0 else stored == hdu.header.get("BLANK", None)
                    expected_physical = stored.astype(np.float64) * hdu.header.get("BSCALE", 1) + hdu.header.get("BZERO", 0)
                    observed_physical = np.frombuffer(native_physical, dtype=np.float64)
                    assert np.array_equal(observed_physical[~missing], expected_physical[~missing], equal_nan=True), (producer, index, "physical")
                    physical = packed(expected_physical.tobytes())
                images.append({"id": index, "bitpix": hdu.header["BITPIX"],
                               "axes": [hdu.header["NAXIS%d" % (i+1)] for i in range(hdu.header["NAXIS"])],
                               "nativeLittleEndian": packed(raw), "physicalLittleEndian": physical,
                               "checksum": "Astropy and CFITSIO verified"})
        fixtures.append({"producer": producer, "file": packed(path.read_bytes()), "images": images,
                         "cfitsioReceipt": receipt.stdout})
    result = {"astropy": astropy.__version__, "numpy": np.__version__, "byteorder": "little",
              "packages": run(["dpkg-query", "-W", "python3-astropy", "libcfitsio-dev", "gcc"]).stdout,
              "sources": {"create.py": packed(pathlib.Path(__file__).read_bytes())["sha256"],
                          "native.c": packed(pathlib.Path(args.source).read_bytes())["sha256"]}, "fixtures": fixtures}
    pathlib.Path(args.output).write_text(json.dumps(result, separators=(",", ":")) + "\n")
