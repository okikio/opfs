"""Authored reciprocal SciPy/netCDF-C classic fixture producer. No runtime SDK dependency."""
import argparse, base64, hashlib, json, pathlib, subprocess, sys, tempfile
import numpy as np
import scipy
from scipy.io import netcdf_file

def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        print(repr(args), result.stdout, result.stderr, file=sys.stderr)
        result.check_returncode()
    return result
def packed(data):
    return {"base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}
parser = argparse.ArgumentParser(); parser.add_argument("--source", required=True); parser.add_argument("--output", required=True); args = parser.parse_args()
fixtures = []
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory); exe = root / "native"
    run(["cc", args.source, "-lnetcdf", "-o", str(exe)])
    for version in (1, 2):
        paths = []
        c_path = root / ("native%d.nc" % version)
        native_receipt = run([str(exe), "write", str(c_path), str(version), str(root)]).stdout
        paths.append(("netCDF-C", "mixed", c_path))
        for profile in ("single-byte", "single-char", "single-short", "empty"):
            path = root / ("native%d-%s.nc" % (version,profile))
            run([str(exe), "write", str(path), str(version), profile])
            paths.append(("netCDF-C",profile,path))
        for profile in ("mixed", "large", "single-byte", "single-char", "single-short", "empty"):
            path = root / ("scipy%d-%s.nc" % (version, profile))
            with netcdf_file(path, "w", version=version) as dataset:
                dataset.createDimension("time", None); dataset.createDimension("three", 3)
                dataset.title = "Authored classic format fixture"
                if profile in ("mixed", "large"):
                    dataset.createDimension("two", 2)
                    for name, code, values in [("byte", "b", [-128,-127,-1,0,1,127]), ("char", "c", [0,1,65,127,128,255]), ("short", "h", [-32768,-32767,-1,0,1,32767]), ("int", "i", [-2147483648,-2147483647,-1,0,1,2147483647]), ("float", "f", [-0.,np.nan,np.inf,-np.inf,1.25,3.5]), ("double", "d", [-0.,np.nan,np.inf,-np.inf,1.25,3.5])]:
                        var = dataset.createVariable(name, code, ("two", "three"))
                        array = np.array(values, dtype=np.uint8).view("S1") if code == "c" else np.array(values, dtype=code)
                        var[:] = array.reshape(2, 3)
                    first = dataset.createVariable("record_short", "h", ("time", "three")); first._FillValue = np.int16(-999); first.missing_value = np.array([-777,-888], dtype=np.int16); first.scale_factor = np.float32(.5); first.add_offset = np.float32(10)
                    rows = 30000 if profile == "large" else 3
                    first[:] = np.tile(np.array([[-999,1,2],[3,-777,5],[6,7,-888]], dtype=np.int16),(rows//3,1))
                    second = dataset.createVariable("record_byte", "b", ("time",)); second[:] = np.tile(np.array([-1,0,1], dtype=np.int8),rows//3)
                    third = dataset.createVariable("record_double", "d", ("time", "three")); third[:] = np.arange(rows*3, dtype=np.float64).reshape(rows,3)
                else:
                    code = "b" if profile in ("single-byte", "empty") else "c" if profile == "single-char" else "h"
                    var = dataset.createVariable("record", code, ("time", "three"))
                    if profile != "empty":
                        values = np.arange(9, dtype=np.uint8).view("S1") if code == "c" else np.arange(9, dtype=code)
                        var[:] = values.reshape(3,3)
            paths.append(("SciPy", profile, path))
        for index, (producer, profile, path) in enumerate(paths):
            out = root / ("dump%d-%d" % (version,index)); out.mkdir()
            receipt = run([str(exe), "read", str(path), str(version), str(out)]).stdout
            variables = []
            with netcdf_file(path, "r", mmap=False, maskandscale=False) as dataset:
                for varid, (name, var) in enumerate(dataset.variables.items()):
                    # SciPy preserves header variable order on reading. Cross-check every native byte.
                    raw = var.data.astype(var.data.dtype.newbyteorder("="), copy=True).tobytes()
                    assert raw == (out / (str(varid) + ".bin")).read_bytes(), (producer,profile,name)
                    subset = out / (str(varid) + ".subset")
                    if subset.exists(): assert subset.read_bytes() == var.data[1:3].astype(var.data.dtype.newbyteorder("="), copy=True).tobytes()
                    variables.append({"id": varid,"name":name,"shape":list(var.shape),"nativeLittleEndian":packed(raw),"subset":packed(subset.read_bytes()) if subset.exists() else None})
            fixtures.append({"producer":producer,"profile":profile,"version":version,"file":packed(path.read_bytes()),"variables":variables,"nativeReceipt":receipt})
    result = {"scipy":scipy.__version__,"numpy":np.__version__,"native":native_receipt,"byteorder":sys.byteorder,
              "packages":run(["dpkg-query","-W","python3-scipy","libnetcdf-dev","netcdf-bin","gcc","libc6-dev"]).stdout,
              "sources":{"create.py":hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),"native.c":hashlib.sha256(pathlib.Path(args.source).read_bytes()).hexdigest()},"fixtures":fixtures}
    pathlib.Path(args.output).write_text(json.dumps(result,separators=(",", ":"))+"\n")
