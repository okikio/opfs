"""Independent signed Debian CLI fixtures; package source does not run or import these tools."""
import base64, hashlib, json, subprocess

def command(args, data=None):
    return subprocess.run(args,input=data,capture_output=True,check=True).stdout
payload = bytes(range(256))*64+b"native-codec\n"*100
result={"producer":"signed Debian brotli and zstd CLIs", "packages":command(["dpkg-query","-W","-f=${Package} ${Version}\n","brotli","zstd"]).decode(),"payload":base64.b64encode(payload).decode(),"formats":{}}
for name,argv in [("brotli",["brotli","-c"]),("zstd",["zstd","-q","-c"])]:
    encoded=command(argv,payload); empty=command(argv,b"")
    assert command([name,"-d","-c"],encoded)==payload
    result["formats"][name]={"bytes":base64.b64encode(encoded).decode(),"empty":base64.b64encode(empty).decode(),"sha256":hashlib.sha256(encoded).hexdigest()}
open("/native.json","w").write(json.dumps(result,indent=2)+"\n")
