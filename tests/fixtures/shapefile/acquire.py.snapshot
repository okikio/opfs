"""Inspect a single pinned test-only PyShp wheel without package import or installation."""
import hashlib, json, pathlib, stat, sys, urllib.request, zipfile
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('PyShp acquisition refuses all redirects')
URL='https://files.pythonhosted.org/packages/ac/72/1f79dab76eb7651b5e3622a46b18a7f93f57c3a1317b712986c58810895e/pyshp-3.1.6-py3-none-any.whl'
SHA='be8cd9436dcbde477c63ea789f7dcdea3af19f17ea84f2744bfc12efe9145d1e'
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
with urllib.request.build_opener(NoRedirect()).open(URL,timeout=30) as response:
    raw=response.read(131073)
assert len(raw)==73744 and hashlib.sha256(raw).hexdigest()==SHA
wheel=root/'pyshp-3.1.6-py3-none-any.whl';wheel.write_bytes(raw)
entries=[]
with zipfile.ZipFile(wheel) as archive:
    infos=archive.infolist();assert 0<len(infos)<=128 and sum(i.file_size for i in infos)<=2*1024*1024
    assert len({i.filename for i in infos})==len(infos)
    for info in infos:
        parts=info.filename.split('/')
        assert chr(92) not in info.filename and all(p not in ['', '.', '..'] for p in parts)
        assert info.filename=='shapefile.py' or (len(parts)>1 and parts[0]=='pyshp-3.1.6.dist-info')
        assert not info.flag_bits&1 and info.compress_type in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]
        assert not info.is_dir() and stat.S_IFMT(info.external_attr>>16) in [0,stat.S_IFREG]
        assert info.file_size<=512*1024
        b=archive.read(info);assert len(b)==info.file_size;entries.append({'name':info.filename,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
        if info.filename in ['shapefile.py','pyshp-3.1.6.dist-info/METADATA','pyshp-3.1.6.dist-info/LICENSE.TXT','pyshp-3.1.6.dist-info/licenses/LICENSE.TXT']:
            (root/info.filename.replace('/','_')).write_bytes(b)
    assert not any(i.filename.endswith(('.so','.pth')) for i in infos)
(root/'acquisition.json').write_text(json.dumps({'url':URL,'bytes':len(raw),'sha256':SHA,'python':sys.version,'entries':entries},indent=2)+'\n')
