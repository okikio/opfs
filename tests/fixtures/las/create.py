"""Authored LAS1.2 reciprocal producer. Test-only laspy/NumPy; no candidate imports.

Run in bounded Debian trixie container with signed python3-laspy/python3-numpy:
  /usr/bin/python3 /produce.py --output /tmp/independent.json
Native laspy writes and an independent struct writer both feed laspy's reader.
Every original column, scaled XYZ, full record bytes and selected record bytes
are retained with hashes. Extensions are opaque, not an ExtraBytes/CRS claim.
"""
import argparse, base64, hashlib, io, json, pathlib, struct, subprocess
import laspy
import numpy as np

def packed(data):
    return {"base64":base64.b64encode(data).decode(),"sha256":hashlib.sha256(data).hexdigest()}
def column(values, dtype):
    return np.asarray(values,dtype=dtype).tobytes()
def columns(cloud):
    result={name:column(getattr(cloud,name),dtype) for name,dtype in [
        ("X","<i4"),("Y","<i4"),("Z","<i4"),("intensity","<u2"),
        ("return_number","u1"),("number_of_returns","u1"),("scan_direction_flag","u1"),
        ("edge_of_flight_line","u1"),("classification","u1"),("synthetic","u1"),
        ("key_point","u1"),("withheld","u1"),("scan_angle_rank","i1"),
        ("user_data","u1"),("point_source_id","<u2")]}
    for name in ("gps_time","red","green","blue"):
        if name in cloud.point_format.dimension_names:
            result[name]=column(getattr(cloud,name),"<f8" if name=="gps_time" else "<u2")
    for name in ("x","y","z"): result[name]=column(getattr(cloud,name),"<f8")
    return result

def cloud(fmt,count,extra=False):
    header=laspy.LasHeader(version="1.2",point_format=fmt)
    header.scales=np.array([.01,.125,2.]);header.offsets=np.array([1000.,-2000.,42.])
    header.global_encoding.value=fmt%2
    if extra:
        header.extra_header_bytes=b"opaque-header-extension"
        header.add_extra_dim(laspy.ExtraBytesParams(name="opaque",type=np.uint8))
    header.vlrs.append(laspy.VLR(user_id="OPFS_test",record_id=65000,description="inert authored bytes",record_data=bytes(range(32))))
    value=laspy.LasData(header);index=np.arange(count,dtype=np.int64)
    value.X=(index*37-500).astype(np.int32);value.Y=(index*-13+901).astype(np.int32);value.Z=(index%100-50).astype(np.int32)
    if count: value.X[0]=np.iinfo(np.int32).min;value.Y[-1]=np.iinfo(np.int32).max
    value.intensity=(index*1777%65536).astype(np.uint16)
    value.return_number=(index%5+1).astype(np.uint8);value.number_of_returns=np.full(count,5,dtype=np.uint8)
    value.scan_direction_flag=(index%2).astype(np.uint8);value.edge_of_flight_line=(index%3==0).astype(np.uint8)
    value.classification=(index%32).astype(np.uint8);value.synthetic=(index%2).astype(np.uint8)
    value.key_point=(index%3==0).astype(np.uint8);value.withheld=(index%7==0).astype(np.uint8)
    value.scan_angle_rank=np.resize(np.array([-90,-1,0,1,90],dtype=np.int8),count)
    value.user_data=(index%256).astype(np.uint8);value.point_source_id=(index*31%65536).astype(np.uint16)
    if fmt in (1,3): value.gps_time=index*.5+123456.
    if fmt in (2,3):
        value.red=(index*111%65536).astype(np.uint16);value.green=(index*222%65536).astype(np.uint16);value.blue=(index*333%65536).astype(np.uint16)
    if extra: value.opaque=(index%256).astype(np.uint8)
    return value

def manual(value,extra):
    fmt=value.point_format.id;n=len(value.points);width=[20,28,26,34][fmt]+(1 if extra else 0)
    extension=b"manual-opaque-header" if extra else b""
    vlr=struct.pack("<H16sHH32s",0,b"OPFS_test",65000,32,b"inert authored bytes")+bytes(range(32))
    header=bytearray(227+len(extension));header[:4]=b"LASF";struct.pack_into("<H",header,6,fmt%2)
    header[24:26]=bytes([1,2]);header[26:58]=b"OTHER".ljust(32,b"\0");header[58:90]=b"OPFS fixture struct writer".ljust(32,b"\0")
    struct.pack_into("<HII BHI",header,94,len(header),len(header)+len(vlr),1,fmt,width,n)
    for r in range(5): struct.pack_into("<I",header,111+r*4,int(np.count_nonzero(np.asarray(value.return_number)==r+1)))
    for axis in range(3): struct.pack_into("<d",header,131+axis*8,float(value.header.scales[axis]));struct.pack_into("<d",header,155+axis*8,float(value.header.offsets[axis]))
    for axis,key in enumerate(("x","y","z")):
        values=np.asarray(getattr(value,key));struct.pack_into("<dd",header,179+axis*16,float(values.max()) if n else 0.,float(values.min()) if n else 0.)
    header[227:]=extension;records=bytearray()
    for i in range(n):
        flags=int(value.return_number[i])|int(value.number_of_returns[i])<<3|int(value.scan_direction_flag[i])<<6|int(value.edge_of_flight_line[i])<<7
        classification=int(value.classification[i])|int(value.synthetic[i])<<5|int(value.key_point[i])<<6|int(value.withheld[i])<<7
        records+=struct.pack("<iiiHBBbBH",int(value.X[i]),int(value.Y[i]),int(value.Z[i]),int(value.intensity[i]),flags,classification,int(value.scan_angle_rank[i]),int(value.user_data[i]),int(value.point_source_id[i]))
        if fmt in (1,3): records+=struct.pack("<d",float(value.gps_time[i]))
        if fmt in (2,3): records+=struct.pack("<HHH",int(value.red[i]),int(value.green[i]),int(value.blue[i]))
        if extra:records+=bytes([i%256])
    return bytes(header)+vlr+bytes(records)

parser=argparse.ArgumentParser();parser.add_argument("--output",required=True);args=parser.parse_args();fixtures=[]
for fmt in range(4):
    for count,extra in [(0,False),(37,False),(37,True),(12000,False)]:
        value=cloud(fmt,count,extra);original=columns(value)
        for producer in ("laspy","struct"):
            if producer=="laspy":
                stream=io.BytesIO();value.write(stream,do_compress=False);data=stream.getvalue()
            else:data=manual(value,extra)
            actual=laspy.read(io.BytesIO(data));observed=columns(actual)
            assert observed==original,(fmt,count,extra,producer)
            offset=struct.unpack_from("<I",data,96)[0];width=struct.unpack_from("<H",data,105)[0]
            records=data[offset:offset+count*width];assert len(records)==count*width
            begin=min(3,count);end=min(begin+7,count)
            assert columns(actual[begin:end])=={key:raw[begin*(len(raw)//count):end*(len(raw)//count)] if count else b"" for key,raw in original.items()}
            fixtures.append({"producer":producer,"format":fmt,"count":count,"extra":extra,"file":packed(data),"records":packed(records),"subset":packed(records[begin*width:end*width]),"columns":{key:packed(raw) for key,raw in original.items()}})
result={"laspy":laspy.__version__,"numpy":np.__version__,"packages":subprocess.run(["dpkg-query","-W","python3-laspy","python3-numpy"],check=True,capture_output=True,text=True).stdout,"sourceSha256":hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),"fixtures":fixtures}
pathlib.Path(args.output).write_text(json.dumps(result,separators=(",", ":"))+"\n")
