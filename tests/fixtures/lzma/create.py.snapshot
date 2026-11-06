"""Genuine XZ Utils/7-Zip raw codecs, independently full-byte cross-consumed.

No candidate decoder or runtime SDK is used. Framing adaptations are explicitly recorded.
python3 tests/fixtures/lzma/create.py --seven /usr/bin/7zz --output /tmp/lzma.json
"""
import argparse
import base64
import hashlib
import json
import lzma
import pathlib
import random
import struct
import subprocess
import tempfile
import zlib

parser=argparse.ArgumentParser()
parser.add_argument('--seven',default='7zz')
parser.add_argument('--output',default=str(pathlib.Path(__file__).with_name('independent.json')))
args=parser.parse_args()

def command(argv,**kwargs):
    result=subprocess.run(argv,capture_output=True,stdin=subprocess.DEVNULL,timeout=40,**kwargs)
    if result.returncode:
        raise RuntimeError(json.dumps({'argv':argv,'exitCode':result.returncode,
            'stdout':result.stdout.decode(errors='replace'),'stderr':result.stderr.decode(errors='replace')}))
    return result.stdout

def vli(value):
    result=bytearray()
    while value>=128: result.append((value&127)|128);value>>=7
    result.append(value);return bytes(result)

def crc(body):return struct.pack('<I',zlib.crc32(body))

def xz_frame(raw,body):
    # Explicit authored framing over genuine raw LZMA2; native consumer must accept every byte.
    flags=b'\x00\x01';header=b'\xfd7zXZ\x00'+flags+crc(flags)
    block=b'\x02\x00\x21\x01\x08\x00\x00\x00';block+=crc(block)
    data=block+raw+b'\0'*((-len(raw))%4)+crc(body)
    index=b'\x00\x01'+vli(len(block)+len(raw)+4)+vli(len(body));index+=b'\0'*((-len(index))%4);index+=crc(index)
    footer=struct.pack('<I',len(index)//4-1)+flags
    return header+data+index+crc(footer)+footer+b'YZ'

def controls(raw):
    at=0;result=[]
    while at<len(raw):
        start=at;control=raw[at];at+=1
        if control==0:
            if at!=len(raw):raise RuntimeError('Unexpected LZMA2 trailer')
            result.append({'offset':start,'control':control});return result
        if control in [1,2]:
            size=int.from_bytes(raw[at:at+2],'big')+1;at+=2+size
            result.append({'offset':start,'control':control,'unpacked':size});continue
        if control<128:raise RuntimeError('Invalid native control')
        unpacked=((control&31)<<16)+int.from_bytes(raw[at:at+2],'big')+1
        packed=int.from_bytes(raw[at+2:at+4],'big')+1;at+=4
        if control>=192:at+=1
        at+=packed;result.append({'offset':start,'control':control,'packed':packed,'unpacked':unpacked})
    raise RuntimeError('Missing native LZMA2 terminator')

result={'tools':{'7zip':command([args.seven]).decode(errors='replace').splitlines()[:5],
                 'xz':command(['xz','--version']).decode().strip()},'cases':[]}
rng=random.Random(42129);period=bytes(rng.randrange(256) for _ in range(65000))
bodies={'empty':b'','literal':b'Independent native LZMA payload\x00\xff',
        'overlap':b'a'*9000,'wrap':period*3+period[:117]}
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary)
    def store(name,raw,body,profile,origin,**extra):
        result['cases'].append({'name':name,'packed':base64.b64encode(raw).decode(),
            'body':base64.b64encode(body).decode(),'sha256':hashlib.sha256(raw).hexdigest(),
            'profile':profile,'origin':origin,**extra})
    for name,body in bodies.items():
        path=root/(name+'.bin');path.write_bytes(body)
        alone=command(['xz','-T1','--format=lzma','--lzma1=dict=64KiB','-c',str(path)])
        archive=root/(name+'.lzma');archive.write_bytes(alone)
        assert command([args.seven,'x','-so',str(archive)])==body
        store('alone-'+name,alone,body,'alone','Genuine XZ Utils .lzma, independent 7-Zip full-byte consumer')
        raw=command(['xz','-T1','--format=raw','--lzma2=dict=64KiB','-c',str(path)])
        wrapper=xz_frame(raw,body);archive=root/(name+'.xz');archive.write_bytes(wrapper)
        assert command([args.seven,'x','-so',str(archive)])==body
        store('lzma2-'+name,raw,body,'raw-lzma2','Genuine XZ Utils raw LZMA2, independent 7-Zip through explicitly authored XZ wrapper',dictionary=8,controls=controls(raw),consumerFrameSha256=hashlib.sha256(wrapper).hexdigest())
    for name,body in {
        'continuation':b'abcd'*600000,
        'mixed':b'a'*1048576+bytes(rng.randrange(256) for _ in range(200000))+b'b'*1048576,
    }.items():
        path=root/(name+'.bin');path.write_bytes(body)
        raw=command(['xz','-T1','--format=raw','--lzma2=dict=64KiB','-c',str(path)])
        wrapper=xz_frame(raw,body);archive=root/(name+'.xz');archive.write_bytes(wrapper)
        assert command([args.seven,'x','-so',str(archive)])==body
        store('lzma2-'+name,raw,body,'raw-lzma2','Genuine XZ Utils raw LZMA2, independent 7-Zip through explicitly authored XZ wrapper',dictionary=8,controls=controls(raw),consumerFrameSha256=hashlib.sha256(wrapper).hexdigest())
    # Deliberate protocol compositions exercise reset modes over genuine compressed chunks.
    repeated=bodies['overlap'];path=root/'overlap.bin'
    original=command(['xz','-T1','--format=raw','--lzma2=dict=64KiB','-c',str(path)])
    first=original[:-1]
    if first[0]!=224:raise RuntimeError('Expected single fresh native overlap chunk')
    zeros=b'\x02\x00\x03'+b'\0'*4
    state_only=bytes([160])+first[1:5]+first[6:]
    properties_only=bytes([192])+first[1:]
    raw=first+zeros+state_only+zeros+properties_only+b'\0'
    body=repeated+b'\0'*4+repeated+b'\0'*4+repeated
    wrapper=xz_frame(raw,body);archive=root/'reset-composition.xz';archive.write_bytes(wrapper)
    assert command([args.seven,'x','-so',str(archive)])==body
    assert lzma.decompress(raw,format=lzma.FORMAT_RAW,filters=[{'id':lzma.FILTER_LZMA2,'dict_size':65536}])==body
    store('lzma2-reset-composition',raw,body,'raw-lzma2','Explicit authored control/header composition over genuine XZ packed chunks; independent 7-Zip and liblzma full-byte consumers, not direct producer control output',dictionary=8,controls=controls(raw),consumerFrameSha256=hashlib.sha256(wrapper).hexdigest())
    # Every portable lc/lp/pb combination is cross-checked by independent 7-Zip.
    body=b'Context states and positions. '*13
    path=root/'properties.bin';path.write_bytes(body)
    for lc in range(5):
        for lp in range(5-lc):
            for pb in range(5):
                raw=command(['xz','-T1','--format=raw',f'--lzma1=dict=64KiB,lc={lc},lp={lp},pb={pb}','-c',str(path)])
                properties=bytes([(pb*5+lp)*9+lc])+struct.pack('<I',65536)
                archive=root/'properties.lzma';archive.write_bytes(properties+struct.pack('<Q',len(body))+raw)
                assert command([args.seven,'x','-so',str(archive)])==body
                store(f'properties-{lc}-{lp}-{pb}',raw,body,'raw-lzma1','Genuine XZ Utils raw LZMA1; known-size Alone wrapper independently accepted by 7-Zip',properties=list(properties),size=len(body),marker='required')
    for method in ['LZMA','LZMA2']:
        body=bodies['wrap'];path=root/'native.bin';path.write_bytes(body);archive=root/(method+'.7z')
        command([args.seven,'a','-t7z',f'-m0={method}:d64k','-mmt=off','-ms=off','-mhc=off',str(archive),str(path)])
        wire=archive.read_bytes();header=32+struct.unpack_from('<Q',wire,12)[0]
        if wire[header]!=1:raise RuntimeError('Native archive header is encoded')
        raw=wire[32:header]
        if method=='LZMA':
            properties=bytes([0x5d])+struct.pack('<I',65536)
            wrapped=properties+struct.pack('<Q',len(body))+raw
            assert lzma.decompress(wrapped,format=lzma.FORMAT_ALONE)==body
            store('7zip-lzma1',raw,body,'raw-lzma1','Genuine single-file 7-Zip packed extent; independent liblzma known-size Alone wrapper full-byte consumer',properties=list(properties),size=len(body),marker='optional')
        else:
            assert lzma.decompress(raw,format=lzma.FORMAT_RAW,filters=[{'id':lzma.FILTER_LZMA2,'dict_size':65536}])==body
            store('7zip-lzma2',raw,body,'raw-lzma2','Genuine single-file 7-Zip packed extent; independent liblzma raw full-byte consumer',dictionary=8,size=len(body),controls=controls(raw))
pathlib.Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
