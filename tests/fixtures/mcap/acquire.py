"""Acquire and inspect the pinned test-only wheel; never install or execute package code."""
import hashlib, json, pathlib, stat, sys, urllib.request, zipfile
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Wheel acquisition refuses every redirect")
URL = 'https://files.pythonhosted.org/packages/cd/15/fa7ff687a128ec51084a48fb1e039b247a9add47b974c125278d97f370be/mcap-1.6.0-py3-none-any.whl'
SHA = '7cd37fba2cf51d033f2139ca837d2ed3024dcec3cd9f8ecdf3d4d15930df6e17'
root = pathlib.Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
with urllib.request.build_opener(NoRedirect()).open(URL, timeout=30) as response:
    assert urllib.parse.urlparse(response.url).scheme == 'https'
    assert urllib.parse.urlparse(response.url).hostname == 'files.pythonhosted.org'
    raw = response.read(65537)
assert len(raw) == 21955 and hashlib.sha256(raw).hexdigest() == SHA
wheel = root / 'mcap-1.6.0-py3-none-any.whl'; wheel.write_bytes(raw)
with zipfile.ZipFile(wheel) as archive:
    infos = archive.infolist()
    assert len(infos) <= 128 and sum(i.file_size for i in infos) <= 2*1024*1024
    assert len({i.filename for i in infos}) == len(infos)
    entries=[]
    for info in infos:
        assert info.file_size <= 512*1024
        parts=info.filename.split('/')
        assert '\\' not in info.filename and all(p not in ['', '.', '..'] for p in parts)
        assert parts[0] in ['mcap','mcap-1.6.0.dist-info'] and len(parts)>1
        assert not info.flag_bits & 1 and info.compress_type in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]
        kind=stat.S_IFMT(info.external_attr >> 16)
        assert kind in [0,stat.S_IFREG] and not info.is_dir()
        content=archive.read(info)
        entries.append({'name':info.filename,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()})
        if info.filename in ['mcap/writer.py','mcap/stream_reader.py','mcap-1.6.0.dist-info/METADATA','mcap-1.6.0.dist-info/LICENSE','mcap-1.6.0.dist-info/licenses/LICENSE']:
            (root / info.filename.replace('/','_')).write_bytes(content)
    for name in ['mcap/writer.py','mcap/stream_reader.py']:
        text=archive.read(name).decode('utf8')
        assert 'except ImportError:' in text
    assert not any(i.filename.endswith(('.so','.pth')) for i in infos)
(root/'acquisition.json').write_text(json.dumps({'url':URL,'sha256':SHA,'bytes':len(raw),'python':sys.version,'entries':entries},indent=2)+'\n')
