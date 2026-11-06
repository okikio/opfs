"""Candidate-free GDAL/tifffile/libtiff proof. Run only in the reviewed offline test-tool container."""
import os
for name,value in {'GDAL_CACHEMAX':'32','GDAL_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','PROJ_NETWORK':'OFF','GDAL_PAM_ENABLED':'NO'}.items():
    os.environ[name]=value
import sys,json,pathlib,tempfile,base64,hashlib,struct,ctypes,ctypes.util
import numpy as np
import tifffile
from osgeo import gdal,osr

gdal.UseExceptions()
MAX_FILE=1024**2
MAX_TOTAL=8*1024**2

def blob(data):
    return {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'base64':base64.b64encode(data).decode('ascii')}

def scalar(value):
    n=float(value)
    if np.isnan(n):return 'nan'
    if np.isposinf(n):return '+infinity'
    if np.isneginf(n):return '-infinity'
    if n==0 and np.signbit(n):return '-zero'
    return value.item() if hasattr(value,'item') else value

# This direct native API consumer is not independent of GDAL's libtiff backend.
lib=ctypes.CDLL(ctypes.util.find_library('tiff'))
lib.TIFFOpen.argtypes=[ctypes.c_char_p,ctypes.c_char_p];lib.TIFFOpen.restype=ctypes.c_void_p
lib.TIFFClose.argtypes=[ctypes.c_void_p]
lib.TIFFSetDirectory.argtypes=[ctypes.c_void_p,ctypes.c_uint16];lib.TIFFSetDirectory.restype=ctypes.c_int
for name in ['TIFFReadRawStrip','TIFFReadRawTile','TIFFReadEncodedStrip','TIFFReadEncodedTile']:
    f=getattr(lib,name);f.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_ssize_t];f.restype=ctypes.c_ssize_t
lib.TIFFGetVersion.argtypes=[];lib.TIFFGetVersion.restype=ctypes.c_char_p


def physical(data):
    if len(data)>MAX_FILE:raise ValueError('fixture file cap')
    little=data[:2]==b'II';endian='<' if little else '>'
    if data[:2] not in [b'II',b'MM'] or struct.unpack_from(endian+'H',data,2)[0]!=42:raise ValueError('classic TIFF required')
    next_=struct.unpack_from(endian+'I',data,4)[0];pages=[];seen=set()
    while next_:
        if next_ in seen or len(pages)>=16:raise ValueError('IFD cycle/count')
        seen.add(next_);count=struct.unpack_from(endian+'H',data,next_)[0]
        if not 0<count<=1024:raise ValueError('entry count')
        fields={};entries=[]
        for i in range(count):
            at=next_+2+i*12;tag,type_,n=struct.unpack_from(endian+'HHI',data,at)
            unit={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8}[type_]
            size=n*unit;offset=at+8 if size<=4 else struct.unpack_from(endian+'I',data,at+8)[0]
            if offset+size>len(data):raise ValueError('field extent')
            raw=data[offset:offset+size];formats={1:'B',3:'H',4:'I',8:'h',9:'i',11:'f',12:'d'}
            values=list(struct.unpack(endian+formats[type_]*n,raw)) if type_ in formats else None
            fields[tag]={'type':type_,'count':n,'offset':offset,'raw':blob(raw),'values':values}
            entries.append(tag)
        if entries!=sorted(set(entries)):raise ValueError('unordered/duplicate tags')
        def one(tag,default=None):
            return fields[tag]['values'][0] if tag in fields else default
        tiled=324 in fields;width=one(256);height=one(257);samples=one(277,1);bits=fields[258]['values'][0];format_=one(339,1)
        dtype=np.dtype({(1,8):'u1',(1,16):'u2',(1,32):'u4',(2,16):'i2',(2,32):'i4',(3,32):'f4',(3,64):'f8'}[(format_,bits)])
        bw=one(322) if tiled else width;bh=one(323) if tiled else one(278,4294967295)
        offsets=fields[324 if tiled else 273]['values'];lengths=fields[325 if tiled else 279]['values']
        across=(width+bw-1)//bw;blocks=[];raster=np.empty((height,width,samples),dtype=dtype)
        for i,(offset,length) in enumerate(zip(offsets,lengths,strict=True)):
            raw=data[offset:offset+length]
            rows=bh if tiled else min(bh,height-(i//across)*bh)
            if len(raw)!=length or length!=rows*bw*samples*dtype.itemsize:raise ValueError('raw block extent')
            values=np.frombuffer(raw,dtype=dtype.newbyteorder(endian)).reshape(rows,bw,samples)
            x=(i%across)*bw;y=(i//across)*bh;validw=min(bw,width-x);validh=min(rows,height-y)
            raster[y:y+validh,x:x+validw]=values[:validh,:validw]
            blocks.append({'offset':offset,'length':length,'raw':blob(raw)})
        pages.append({'ifdOffset':next_,'width':width,'height':height,'samples':samples,'bits':bits,'sampleFormat':format_,'tiled':tiled,'blockWidth':bw,'blockHeight':bh,'fields':fields,'blocks':blocks,'raster':raster,'dtype':dtype,'endian':endian})
        next_=struct.unpack_from(endian+'I',data,next_+2+count*12)[0]
    return pages


def compare(path,originals,producer):
    data=path.read_bytes();pages=physical(data)
    if len(pages)!=len(originals):raise ValueError('native IFD count differs from authored originals')
    native=gdal.Open(str(path),gdal.GA_ReadOnly)
    if native is None:raise ValueError('GDAL open failed')
    projection=native.GetProjectionRef()
    if len(projection)>8192:raise ValueError('native projection receipt cap')
    native_metadata={'geotransform':list(native.GetGeoTransform()),'areaOrPoint':native.GetMetadataItem('AREA_OR_POINT'),'projection':projection}
    tiff=lib.TIFFOpen(os.fsencode(path),b'r')
    if not tiff:raise ValueError('libtiff open failed')
    output=[]
    try:
        with tifffile.TiffFile(path) as independent:
            for index,(page,original) in enumerate(zip(pages,originals,strict=True)):
                if not lib.TIFFSetDirectory(tiff,index):raise ValueError('libtiff directory')
                # Full authored samples, including NaN and negative zero, independently decoded from physical bytes.
                if page['raster'].dtype!=original.dtype:raise ValueError('dtype mismatch')
                np.testing.assert_array_equal(page['raster'],original)
                np.testing.assert_array_equal(np.signbit(page['raster']),np.signbit(original))
                if page['raster'].tobytes()!=original.tobytes():raise ValueError('complete original sample bits differ')
                decoded=independent.pages[index].asarray()
                if decoded.ndim==2:decoded=decoded[:,:,None]
                np.testing.assert_array_equal(decoded,original)
                np.testing.assert_array_equal(np.signbit(decoded),np.signbit(original))
                bands=[]
                for band in range(original.shape[2]):
                    b=native.GetRasterBand(band+1)
                    if index:b=b.GetOverview(index-1)
                    if b is None:raise ValueError('GDAL expected overview absent')
                    bands.append(b.ReadAsArray())
                decoded=np.stack(bands,axis=2);np.testing.assert_array_equal(decoded,original);np.testing.assert_array_equal(np.signbit(decoded),np.signbit(original))
                for i,block in enumerate(page['blocks']):
                    raw=data[block['offset']:block['offset']+block['length']];buf=ctypes.create_string_buffer(len(raw));method=getattr(lib,'TIFFReadRawTile' if page['tiled'] else 'TIFFReadRawStrip')
                    if method(tiff,i,buf,len(raw))!=len(raw) or buf.raw!=raw:raise ValueError('libtiff full raw block mismatch')
                    method=getattr(lib,'TIFFReadEncodedTile' if page['tiled'] else 'TIFFReadEncodedStrip')
                    if method(tiff,i,buf,len(raw))!=len(raw):raise ValueError('libtiff encoded block extent')
                    expected=np.frombuffer(raw,dtype=page['dtype'].newbyteorder(page['endian'])).astype(page['dtype']).tobytes()
                    if buf.raw!=expected:raise ValueError('libtiff full decoded block bits mismatch')
                # A representative cropped region is checked without generating its oracle from the candidate.
                w=min(3,page['width']);h=min(2,page['height']);x=page['width']-w;y=page['height']-h
                for band in range(original.shape[2]):
                    b=native.GetRasterBand(band+1)
                    if index:b=b.GetOverview(index-1)
                    np.testing.assert_array_equal(b.ReadAsArray(x,y,w,h),original[y:y+h,x:x+w,band])
                fields={str(tag):value for tag,value in page['fields'].items()}
                output.append({k:v for k,v in page.items() if k not in ['raster','dtype','fields'] }|{'fields':fields,'originalBytesLittleEndian':blob(original.astype(original.dtype.newbyteorder('<')).tobytes()),'originalValues':[scalar(v) for v in original.flat],'nativeFullSamples':True,'nativeFullRawBlocks':True,'nativeFullDecodedBlockBits':True,'nativeEdgeWindow':{'x':x,'y':y,'width':w,'height':h}})
    finally:
        lib.TIFFClose(tiff);native=None
    return {'name':path.stem,'producer':producer,'file':blob(data),'pages':output,'nativeDatasetMetadata':native_metadata}


def originals(dtype,channels=1):
    a=np.arange(19*17*channels,dtype=np.dtype(dtype)).reshape(17,19,channels)
    if np.dtype(dtype).kind=='i':a-=200
    if np.dtype(dtype).kind=='f':
        a=a/np.array(4,dtype=dtype);a[0,0,0]=-0.0;a[0,1,0]=np.nan;a[0,2,0]=np.inf;a[0,3,0]=-np.inf
        a.view(np.uint32 if a.dtype.itemsize==4 else np.uint64)[0,1,0]=0x7fc01234 if a.dtype.itemsize==4 else 0x7ff8000000001234
    return a


def main(output):
    fixtures=[]
    with tempfile.TemporaryDirectory(prefix='geotiff-native-') as directory:
        root=pathlib.Path(directory)
        profiles=[('u16-strips-le','u2',gdal.GDT_UInt16,False,'LITTLE',1),('u16-tiles-be','u2',gdal.GDT_UInt16,True,'BIG',1),('rgb-u8-tiles','u1',gdal.GDT_Byte,True,'LITTLE',3),('i16-strips','i2',gdal.GDT_Int16,False,'LITTLE',1),('u32-strips','u4',gdal.GDT_UInt32,False,'BIG',1),('i32-strips','i4',gdal.GDT_Int32,False,'LITTLE',1),('f32-tiles','f4',gdal.GDT_Float32,True,'LITTLE',1),('f64-strips-be','f8',gdal.GDT_Float64,False,'BIG',1),('u16-main-chain-overview','u2',gdal.GDT_UInt16,False,'LITTLE',1)]
        for name,dtype,type_,tiled,endian,channels in profiles:
            path=root/(name+'.tif');a=originals(dtype,channels)
            if name=='u16-main-chain-overview':a.fill(77)
            opts=['BIGTIFF=NO','COMPRESS=NONE','INTERLEAVE=PIXEL','ENDIANNESS='+endian]+(['TILED=YES','BLOCKXSIZE=16','BLOCKYSIZE=16'] if tiled else ['TILED=NO','BLOCKYSIZE=2'])
            dataset=gdal.GetDriverByName('GTiff').Create(str(path),19,17,channels,type_,options=opts)
            if dataset is None:raise ValueError('GTiff create')
            crs=osr.SpatialReference();crs.ImportFromEPSG(4326);dataset.SetSpatialRef(crs);dataset.SetGeoTransform((100,0.5,0,50,0,-0.5))
            dataset.SetMetadataItem('AREA_OR_POINT','Point' if name=='u16-tiles-be' else 'Area')
            for band in range(channels):dataset.GetRasterBand(band+1).WriteArray(a[:,:,band])
            if name=='u16-main-chain-overview':dataset.BuildOverviews('NEAREST',[2])
            dataset.FlushCache();dataset=None
            expected=[a,np.full((9,10,1),77,dtype=np.uint16)] if name=='u16-main-chain-overview' else [a]
            result=compare(path,expected,'GDAL GTiff native CRS builder')
            page=result['pages'][0]
            if page['endian']!=('<' if endian=='LITTLE' else '>') or page['tiled']!=tiled:raise ValueError('native requested storage profile differs')
            directory=page['fields']['34735']['values'];keys={directory[4+i*4]:directory[7+i*4] for i in range(directory[3])}
            if keys.get(1024)!=2 or keys.get(2048)!=4326 or keys.get(1025)!=(2 if name=='u16-tiles-be' else 1):raise ValueError('native generated GeoKey metadata differs')
            if result['nativeDatasetMetadata']['geotransform']!=[100,0.5,0,50,0,-0.5]:raise ValueError('native transform differs')
            fixtures.append(result)
        # Independent Python TIFF writer with explicitly authored geospatial declarations.
        for tiled in [False,True]:
            path=root/('tifffile-'+('tiles' if tiled else 'strips')+'.tif');a=originals('u2')
            geokeys=(1,1,1,3,1024,0,1,1,1025,0,1,1,3072,0,1,32767)
            tifffile.imwrite(path,a[:,:,0],byteorder='>',bigtiff=False,compression=None,metadata=None,photometric='minisblack',tile=(16,16) if tiled else None,rowsperstrip=None if tiled else 2,extratags=[(33550,'d',3,(0.5,0.5,0),False),(33922,'d',6,(0,0,0,100,50,0),False),(34735,'H',len(geokeys),geokeys,False)])
            fixtures.append(compare(path,[a],'tifffile writer; authored unresolved GeoKey values'))
    if len(fixtures)>16 or sum(f['file']['bytes'] for f in fixtures)>MAX_TOTAL:raise ValueError('fixture aggregate cap')
    receipt={'runtime':{'python':sys.version,'interpreter':sys.executable,'numpy':np.__version__,'tifffile':tifffile.__version__,'gdal':gdal.VersionInfo('--version'),'libtiff':lib.TIFFGetVersion().decode('ascii')},'evidence':'GDAL/libtiff share an implementation; tifffile and the standard-library byte oracle are separate readers. Raw bits and semantic values are distinct. No COG/CRS certification.','fixtures':fixtures}
    encoded=json.dumps(receipt,indent=2,allow_nan=False).encode()
    if len(encoded)>16*1024**2:raise ValueError('JSON output cap')
    pathlib.Path(output).write_bytes(encoded+b'\n')

if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('usage: /usr/bin/python3 produce.py OUTPUT')
    main(sys.argv[1])
