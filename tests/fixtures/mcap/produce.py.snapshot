"""Candidate-free native MCAP NONE writer + sequential/seeking consumers, standard-library-only harness."""
import base64, hashlib, io, json, pathlib, struct, sys, zlib
wheel=pathlib.Path(sys.argv[1]); sys.path.insert(0,str(wheel))
assert hashlib.sha256(wheel.read_bytes()).hexdigest()=='7cd37fba2cf51d033f2139ca837d2ed3024dcec3cd9f8ecdf3d4d15930df6e17'
from mcap.writer import Writer, CompressionType, IndexType
from mcap.stream_reader import StreamReader
from mcap.reader import make_reader
from mcap.records import Message, Schema, Attachment, Metadata
import mcap.writer as writer_module
assert writer_module.lz4 is None and writer_module.zstandard is None
out=[]
for mode in ['chunked','unchunked','zero-summary','empty']:
    buf=io.BytesIO()
    w=Writer(buf,compression=CompressionType.NONE,chunk_size=160,
        use_chunking=mode=='chunked',enable_crcs=True,enable_data_crcs=True,
        repeat_channels=mode!='zero-summary',repeat_schemas=mode!='zero-summary',
        use_statistics=mode!='zero-summary',use_summary_offsets=mode!='zero-summary',
        index_types=IndexType.NONE if mode=='zero-summary' else IndexType.ALL)
    w.start(profile='opfs-fixture',library='native-mcap-python-1.6.0')
    originals=[]
    if mode!='empty':
        schema=w.register_schema('literal\ufeffschema','opaque',b'\x00schema\xff')
        ch=w.register_channel('topic/\ufeffliteral','binary',schema,{'owner':'caller','name':'e\u0301'})
        for i in range(7):
            data=bytes((j*31+i*17)%251 for j in range(17+i*29))
            log=2**63+i*1001; publish=log+1
            w.add_message(ch,log,data,publish,sequence=i%3)
            originals.append({'channelId':ch,'sequence':i%3,'logTime':str(log),'publishTime':str(publish),'data':base64.b64encode(data).decode()})
        w.add_attachment(123,456,'literal/../attachment','application/octet-stream',b'\x00native attachment\xff')
        w.add_metadata('metadata',{'a':'one','b':'two'})
    w.finish(); raw=buf.getvalue()
    records=list(StreamReader(io.BytesIO(raw),validate_crcs=True).records)
    actual=[r for r in records if isinstance(r,Message)]
    assert [r.data for r in actual]==[base64.b64decode(x['data']) for x in originals]
    reader=make_reader(io.BytesIO(raw),validate_crcs=True)
    tuples=list(reader.iter_messages(log_time_order=False))
    assert [m.data for _,_,m in tuples]==[base64.b64decode(x['data']) for x in originals]
    if originals:
        assert all(s.data==b'\x00schema\xff' for s,_,_ in tuples)
        assert all(c.topic=='topic/\ufeffliteral' and c.metadata=={'owner':'caller','name':'e\u0301'} for _,c,_ in tuples)
        assert all(r.data==b'\x00schema\xff' for r in records if isinstance(r,Schema))
        assert any(isinstance(r,Schema) for r in records)
        assert [r.data for r in records if isinstance(r,Attachment)]==[b'\x00native attachment\xff']
        assert [r.metadata for r in records if isinstance(r,Metadata)]==[{'a':'one','b':'two'}]
        assert [r.data for r in reader.iter_attachments()]==[b'\x00native attachment\xff']
        assert [r.metadata for r in reader.iter_metadata()]==[{'a':'one','b':'two'}]
    footer=len(raw)-37; assert raw[footer]==2
    start,offset,crc=struct.unpack_from('<QQI',raw,footer+9)
    crcbytes=raw[start:footer+25] if start else raw[footer:footer+25]
    assert zlib.crc32(crcbytes)==crc
    out.append({'name':mode,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode(),
        'messages':originals,'sequentialFullBytes':True,'seekingFullBytes':True,'schemaFullBytes':bool(originals),'attachmentFullBytes':bool(originals),'metadataExact':bool(originals),
        'footer':{'offset':footer,'summaryStart':start,'summaryOffsetStart':offset,'crc':crc,'independentCrc':zlib.crc32(crcbytes)}})
pathlib.Path(sys.argv[2]).write_text(json.dumps({'producer':'mcap 1.6.0','python':sys.version,'wheelSha256':hashlib.sha256(wheel.read_bytes()).hexdigest(),'fixtures':out},indent=2)+'\n')
