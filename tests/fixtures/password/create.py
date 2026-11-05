"""Genuine 7-Zip and InfoZIP ZipCrypto fixtures decrypted by Python zipfile.

python3 tests/fixtures/password/create.py --seven /usr/bin/7zz --zip /usr/bin/zip
No candidate code is imported. Public test password bytes are ASCII.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import tempfile
import zipfile

parser=argparse.ArgumentParser()
parser.add_argument('--seven',default='7zz')
parser.add_argument('--zip',default='zip')
parser.add_argument('--output',default=str(pathlib.Path(__file__).with_name('independent.json')))
args=parser.parse_args()

def command(argv,**kwargs):
    result=subprocess.run(argv,capture_output=True,timeout=20,**kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'command':argv,'exitCode':result.returncode,'stderr':result.stderr.decode(errors='replace'),'stdout':result.stdout.decode(errors='replace')}))
    return result.stdout

password=b'fixture-password'
result={}
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary)
    bodies={'first.bin':bytes(range(73)),'large.bin':bytes((i*31+17)%251 for i in range(131072)),
            'last.bin':b'late\x00binary\xffpayload','empty':b''}
    for name,body in bodies.items():(root/name).write_bytes(body)
    for profile,method in [('stored','Copy'),('deflate','Deflate')]:
        archive=root/(profile+'.zip')
        argv=[args.seven,'a','-tzip','-mm='+method,'-mem=ZipCrypto','-p'+password.decode(),str(archive),*bodies]
        command(argv,cwd=root,stdin=subprocess.DEVNULL)
        with zipfile.ZipFile(archive) as independent:
            for name,body in bodies.items():assert independent.read(name,pwd=password)==body,(profile,name)
            flags={item.filename:item.flag_bits for item in independent.infolist()}
        encoded=archive.read_bytes()
        result[profile]={'producer':command([args.seven],stdin=subprocess.DEVNULL).decode(errors='replace').splitlines()[:5],
                         'consumer':'Python stdlib zipfile.ZipFile.read with password; full original byte comparisons',
                         'command':[args.seven,'a','-tzip','-mm='+method,'-mem=ZipCrypto','-p'+password.decode(),profile+'.zip',*bodies],
                         'password':base64.b64encode(password).decode(),'independentPayloadVerified':True,'flags':flags,
                         'sha256':hashlib.sha256(encoded).hexdigest(),'archive':base64.b64encode(encoded).decode(),
                         'entries':[{'name':name,'body':base64.b64encode(body).decode()} for name,body in bodies.items()]}
    # Unknown input size forces a descriptor-capable encryption-header check profile.
    archive=root/'descriptor.zip';body=b'stdin payload\x00\xff'+bytes(range(91))
    argv=[args.seven,'a','-tzip','-mm=Copy','-mem=ZipCrypto','-p'+password.decode(),'-sidescriptor.bin',str(archive)]
    attempted=subprocess.run(argv,cwd=root,input=body,capture_output=True,timeout=20)
    diagnostic={'command':[args.seven,'a','-tzip','-mm=Copy','-mem=ZipCrypto','-p'+password.decode(),'-sidescriptor.bin','descriptor.zip'],
                'exitCode':attempted.returncode,'stderr':attempted.stderr.decode(errors='replace'),'stdout':attempted.stdout.decode(errors='replace')}
    if archive.exists():archive.unlink()
    argv=[args.zip,'-P',password.decode(),'-0',str(archive),'-']
    command(argv,cwd=root,input=body)
    with zipfile.ZipFile(archive) as independent:
        assert independent.read('-',pwd=password)==body
        flags={item.filename:item.flag_bits for item in independent.infolist()}
    encoded=archive.read_bytes()
    result['descriptor']={'producer':command([args.zip,'-v'],stdin=subprocess.DEVNULL).decode(errors='replace').splitlines()[:5],'consumer':result['stored']['consumer'],'command':[args.zip,'-P',password.decode(),'-0','descriptor.zip','-'],'sevenStdinDiagnostic':diagnostic,
                          'password':base64.b64encode(password).decode(),'independentPayloadVerified':True,'flags':flags,
                          'sha256':hashlib.sha256(encoded).hexdigest(),'archive':base64.b64encode(encoded).decode(),
                          'entries':[{'name':'-','body':base64.b64encode(body).decode()}]}
pathlib.Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
