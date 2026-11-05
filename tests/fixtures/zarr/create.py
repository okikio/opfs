"""Authored NumPy/Zarr v2 reciprocal fixture producer; no candidate code imported."""
import argparse, base64, hashlib, itertools, json, pathlib, subprocess, tempfile
import numpy as np
import zarr

def packed(data):
    return {"base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}
def stores(store):
    return {key: packed(bytes(store[key])) for key in sorted(store.keys())}
def canonical(array):
    if array.dtype.kind == "b": return array.astype(np.uint8).tobytes(order="C")
    return array.astype(array.dtype.newbyteorder("="),copy=True).tobytes(order="C")
def manual(store, values, chunks, order, separator=".", fill=0):
    dtype=values.dtype
    store[".zarray"] = json.dumps({"zarr_format":2,"shape":list(values.shape),"chunks":list(chunks),"dtype":dtype.str,"compressor":None,"filters":[],"fill_value":fill,"order":order,"dimension_separator":separator},separators=(",", ":")).encode()
    grid=[(size+chunk-1)//chunk for size,chunk in zip(values.shape,chunks)]
    for coordinate in itertools.product(*(range(size) for size in grid)):
        data=np.full(chunks,fill,dtype=dtype,order=order)
        logical=tuple(slice(c*chunk,min((c+1)*chunk,size)) for c,chunk,size in zip(coordinate,chunks,values.shape))
        local=tuple(slice(0,s.stop-s.start) for s in logical)
        data[local]=values[logical]
        key=separator.join(map(str,coordinate)) if coordinate else "0"
        store[key]=data.tobytes(order=order)

parser=argparse.ArgumentParser();parser.add_argument("--output",required=True);args=parser.parse_args();fixtures=[]
types=["|b1","|i1","|u1",">i2","<i2",">u2","<u2",">i4","<i4",">u4","<u4",">i8","<i8",">u8","<u8",">f4","<f4",">f8","<f8"]
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory)
    for index,dtype in enumerate(types):
        for order in ("C","F"):
            kind=np.dtype(dtype).kind
            values=np.arange(35,dtype=np.int64).reshape(7,5).astype(dtype)
            if kind=="b": values=(np.arange(35).reshape(7,5)%3==0)
            if kind=="i": values[0,0]=-1
            if kind in "iu" and np.dtype(dtype).itemsize==8: values[-1,-1]=np.iinfo(dtype).max
            if kind=="f": values[0,0]=-0.;values[0,1]=np.nan;values[0,2]=np.inf;values[0,3]=-np.inf
            for producer in ("Zarr","manual"):
                path=root/("%d-%s-%s"%(index,order,producer));store=zarr.DirectoryStore(str(path));separator="/" if order=="F" else "."
                if producer=="Zarr":
                    array=zarr.create(shape=values.shape,chunks=(3,4),dtype=dtype,order=order,compressor=None,filters=None,fill_value=0,store=store,dimension_separator=separator)
                    array[:]=values
                else: manual(store,values,(3,4),order,separator)
                actual=zarr.open_array(store=store,mode="r")[:]
                assert canonical(actual)==canonical(values),(dtype,order,producer)
                fixtures.append({"producer":producer,"profile":"numeric","dtype":dtype,"order":order,"shape":list(values.shape),"chunks":[3,4],"objects":stores(store),"original":packed(canonical(values))})
    for profile,shape,chunks,fill in [("scalar",(),(),0),("empty",(0,3),(2,2),0),("missing",(7,5),(3,4),-7),("missing-nan",(7,5),(3,4),float("nan")),("large",(512,257),(64,64),0)]:
        store=zarr.DirectoryStore(str(root/profile));values=np.arange(np.prod(shape) if shape else 1,dtype=np.float32).reshape(shape)
        array=zarr.create(shape=shape,chunks=chunks,dtype=values.dtype,order="C",compressor=None,filters=None,fill_value=fill,store=store);array[...]=values
        if profile.startswith("missing"):
            del store["0.0"];values[:3,:4]=fill
        assert canonical(array[...])==canonical(values),profile
        fixtures.append({"producer":"Zarr","profile":profile,"dtype":values.dtype.str,"order":"C","shape":list(shape),"chunks":list(chunks),"objects":stores(store),"original":packed(canonical(values))})
    # NumPy boolean truth is nonzero; preserve original noncanonical bytes in the receipt.
    store=zarr.DirectoryStore(str(root/"bool-noncanonical"));manual(store,np.array([False,True,True,True]),(4,),"C");store["0"]=bytes([0,2,255,1]);observed=zarr.open_array(store=store,mode="r")[:]
    assert np.array_equal(observed,np.array([False,True,True,True]))
    fixtures.append({"producer":"manual","profile":"boolean-noncanonical","dtype":"|b1","order":"C","shape":[4],"chunks":[4],"objects":stores(store),"original":packed(observed.astype(np.uint8).tobytes())})
    result={"zarr":zarr.__version__,"numpy":np.__version__,"packages":subprocess.run(["dpkg-query","-W","python3-zarr","python3-numpy"],check=True,capture_output=True,text=True).stdout,"sourceSha256":hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),"byteorder":"little","fixtures":fixtures}
    pathlib.Path(args.output).write_text(json.dumps(result,separators=(",", ":"))+"\n")
