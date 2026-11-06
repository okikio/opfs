"""Native LZ4 CLI producer, independent liblz4-frame consumer and xxhsum32 vectors.

python3 tests/fixtures/lz4/create.py --lz4 /usr/bin/lz4 --xxhsum /usr/bin/xxhsum
Full original bytes are compared through the C frame API, not the candidate.
Only signed distro test tools are needed; the package adds no runtime dependency.
"""
import argparse
import base64
import ctypes
import ctypes.util
import hashlib
import json
import pathlib
import subprocess
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('--lz4',default='lz4')
parser.add_argument('--xxhsum',default='xxhsum')
parser.add_argument('--output',default=str(pathlib.Path(__file__).with_name('independent.json')))
args=parser.parse_args()

def command(argv,**kwargs):
    result=subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,timeout=30,**kwargs)
    if result.returncode:raise RuntimeError(json.dumps({'command':argv,'exitCode':result.returncode,'stdout':result.stdout.decode(errors='replace'),'stderr':result.stderr.decode(errors='replace')}))
    return result.stdout

library=ctypes.CDLL(ctypes.util.find_library('lz4'))
library.LZ4F_createDecompressionContext.argtypes=[ctypes.POINTER(ctypes.c_void_p),ctypes.c_uint]
library.LZ4F_createDecompressionContext.restype=ctypes.c_size_t
library.LZ4F_decompress.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),ctypes.c_void_p]
library.LZ4F_decompress.restype=ctypes.c_size_t
library.LZ4F_freeDecompressionContext.argtypes=[ctypes.c_void_p]
library.LZ4F_isError.argtypes=[ctypes.c_size_t];library.LZ4F_isError.restype=ctypes.c_uint
library.LZ4_versionString.restype=ctypes.c_char_p

def independent(data):
    context=ctypes.c_void_p();assert not library.LZ4F_isError(library.LZ4F_createDecompressionContext(ctypes.byref(context),100))
    position=0;chunks=[];source=ctypes.create_string_buffer(data)
    try:
        for iteration in range(10000):
            output=ctypes.create_string_buffer(65536);output_size=ctypes.c_size_t(65536);input_size=ctypes.c_size_t(len(data)-position)
            remaining=library.LZ4F_decompress(context,output,ctypes.byref(output_size),ctypes.byref(source,position),ctypes.byref(input_size),None)
            assert not library.LZ4F_isError(remaining),remaining
            position+=input_size.value;chunks.append(output.raw[:output_size.value])
            if remaining==0:assert position==len(data);return b''.join(chunks)
            assert input_size.value or output_size.value
        raise AssertionError('independent iteration bound')
    finally:library.LZ4F_freeDecompressionContext(context)

producer=command([args.lz4,'--version']).decode(errors='replace').strip()
result={'producer':producer,'consumer':'liblz4 LZ4F_decompress '+library.LZ4_versionString().decode(),'frames':{},'hashes':[]}
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary)
    # A 65000-byte period fits the 65535-byte match-distance limit and crosses 64 KiB block boundaries.
    seed=bytearray();state=0x12345678
    for index in range(65536):
        state=(state*1664525+1013904223)&0xffffffff;seed.append(state>>24)
    bodies={'linked':bytes(seed[:65000])*2+bytes(seed[:3001]),'literal':bytes(seed[:4097]),'small':b'LZ4 small\x00\xffpayload','empty':b'','overlap':b'A'*100000,'big1':b'A'*300000,'big2':b'A'*1100000}
    profiles=[('independent',['-B4','-BI','-BX','--content-size'],'linked'),('dependent',['-B4','-BD','-BX','--content-size'],'linked'),
              ('content-only',['-B4','-BI'],'small'),('no-checksum',['-B4','-BI','--no-frame-crc'],'small'),('raw',['-B4','-BI','-BX'],'literal'),
              ('empty',['-B4','-BI','-BX','--content-size'],'empty'),('overlap',['-B4','-BI','-BX','--content-size'],'overlap')]
    profiles += [('block'+str(size),['-B'+str(size),'-BI','-BX','--content-size'],{5:'linked',6:'big1',7:'big2'}[size]) for size in [5,6,7]]
    for name,flags,body_name in profiles:
        body=bodies[body_name];path=root/(name+'.bin');path.write_bytes(body);archive=root/(name+'.lz4')
        argv=[args.lz4,'-q','-f',*flags,str(path),str(archive)];command(argv)
        data=archive.read_bytes();assert independent(data)==body,name
        result['frames'][name]={'command':argv,'independentPayloadVerified':True,'sha256':hashlib.sha256(data).hexdigest(),
            'archive':base64.b64encode(data).decode(),'body':base64.b64encode(body).decode()}
    for size in [0,1,3,4,7,15,16,17,31,32,33,255,4097]:
        body=bytes((index*31+17)%251 for index in range(size));path=root/'hash.bin';path.write_bytes(body)
        digest=command([args.xxhsum,'-H0',str(path)]).decode().split()[0]
        result['hashes'].append({'body':base64.b64encode(body).decode(),'xxh32':digest})
    # Header mutation controls use independent native xxhsum output, never candidate checksum code.
    def header_control(name, descriptor, body):
        path=root/'header.bin';path.write_bytes(descriptor)
        header_hash=int(command([args.xxhsum,'-H0',str(path)]).decode().split()[0],16)
        data=b'\x04\x22\x4d\x18'+descriptor+bytes([(header_hash>>8)&255])+body
        result.setdefault('controls',{})[name]=base64.b64encode(data).decode()
    base=base64.b64decode(result['frames']['no-checksum']['archive'])
    header_control('dictionary-zero',bytes([base[4]|1,base[5]])+bytes(4),base[7:])
    sized=base64.b64decode(result['frames']['independent']['archive'])
    header_control('unsafe-size',sized[4:6]+(2**53).to_bytes(8,'little'),sized[15:])
    header_control('size-mismatch',sized[4:6]+(len(bodies['linked'])+1).to_bytes(8,'little'),sized[15:])
    result['hashProducer']=command([args.xxhsum,'--version']).decode(errors='replace').strip()
pathlib.Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
