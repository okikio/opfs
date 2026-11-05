"""Genuine 7-Zip WinZip AES archives with independent libarchive payload checks.

python3 tests/fixtures/aes/create.py --seven /usr/bin/7zz --bsdtar /usr/bin/bsdtar
AE-1 controls explicitly adapt AE-2 metadata and add original plaintext CRCs;
libarchive must accept and compare their complete original payloads too.
No candidate code or runtime dependency is used. Passwords are public test data.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import struct
import subprocess
import tempfile
import zlib

parser = argparse.ArgumentParser()
parser.add_argument('--seven', default='7zz')
parser.add_argument('--bsdtar', default='bsdtar')
parser.add_argument('--output', default=str(pathlib.Path(__file__).with_name('independent.json')))
args = parser.parse_args()

def command(argv, **kwargs):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, **kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'command': argv, 'exitCode': result.returncode,
            'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}))
    return result.stdout

password = 'fixture-password'
producer = command([args.seven]).decode(errors='replace').splitlines()[:5]
consumer = command([args.bsdtar, '--version']).decode().strip()
result = {}
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    bodies = {'first.bin': bytes(range(73)), 'large.bin': bytes((i*31+17)%251 for i in range(8197)),
              'odd.bin': b'odd binary\x00\xffpayload', 'empty': b''}
    for name, body in bodies.items(): (root/name).write_bytes(body)
    for strength in [128,192,256]:
        archive = root/('aes%d.zip'%strength)
        argv = [args.seven,'a','-tzip','-mm=Copy','-mem=AES%d'%strength,'-p'+password,str(archive),*bodies]
        command(argv,cwd=root)
        original = archive.read_bytes()
        for version in [2,1]:
            data = bytearray(original)
            if version == 1:
                # Adapt only the AE version and CRC metadata; encrypted bytes/tag stay genuine 7-Zip output.
                directory = struct.unpack_from('<I', data, len(data)-6)[0]
                at = directory
                while data[at:at+4] == b'PK\x01\x02':
                    name_size, extra_size, comment_size = struct.unpack_from('<HHH',data,at+28)
                    name = bytes(data[at+46:at+46+name_size]).decode()
                    crc = zlib.crc32(bodies[name]); struct.pack_into('<I',data,at+16,crc)
                    local = struct.unpack_from('<I',data,at+42)[0];struct.pack_into('<I',data,local+14,crc)
                    for extra, size in [(at+46+name_size,extra_size),(local+30+struct.unpack_from('<H',data,local+26)[0],struct.unpack_from('<H',data,local+28)[0])]:
                        end=extra+size
                        while extra<end:
                            tag,length=struct.unpack_from('<HH',data,extra)
                            if tag==0x9901:struct.pack_into('<H',data,extra+4,1)
                            extra+=4+length
                    at+=46+name_size+extra_size+comment_size
            key='aes%d-ae%d'%(strength,version)
            output=root/(key+'.zip');output.write_bytes(data)
            destination=root/('out-'+key);destination.mkdir()
            command([args.bsdtar,'--passphrase',password,'-xf',str(output),'-C',str(destination)])
            for name,body in bodies.items():assert (destination/name).read_bytes()==body,(key,name)
            result[key]={'producer':producer,'consumer':consumer,'command':argv,'origin':'genuine 7-Zip AE-2' if version==2 else 'AE-1 metadata/CRC adaptation over genuine 7-Zip ciphertext',
                'independentPayloadVerified':True,'password':base64.b64encode(password.encode()).decode(),
                'sha256':hashlib.sha256(data).hexdigest(),'archive':base64.b64encode(data).decode(),
                'entries':[{'name':name,'body':base64.b64encode(body).decode()} for name,body in bodies.items()]}
    archive=root/'deflate.zip'
    command([args.seven,'a','-tzip','-mm=Deflate','-mem=AES256','-p'+password,str(archive),'large.bin'],cwd=root)
    destination=root/'out-deflate';destination.mkdir()
    command([args.bsdtar,'--passphrase',password,'-xf',str(archive),'-C',str(destination)])
    assert (destination/'large.bin').read_bytes()==bodies['large.bin']
    data=archive.read_bytes()
    result['deflate']={'producer':producer,'consumer':consumer,'origin':'genuine 7-Zip AES DEFLATE rejection control','independentPayloadVerified':True,
        'password':base64.b64encode(password.encode()).decode(),'sha256':hashlib.sha256(data).hexdigest(),'archive':base64.b64encode(data).decode(),
        'entries':[{'name':'large.bin','body':base64.b64encode(bodies['large.bin']).decode()}]}
pathlib.Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
