# Official Python 3.13.11 slim-bookworm index inspected on 2026-11-05.
FROM python@sha256:20080e807bfc404f8450b185cf0fc95d553462673598549613735f70a5b4d5d0
COPY requirements.txt /fixture/requirements.txt
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r /fixture/requirements.txt
# Upstream pyftpdlib 2.2.0 source from primary PyPI metadata, without build dependencies.
RUN python -c 'import hashlib,pathlib,urllib.request; data=urllib.request.urlopen("https://files.pythonhosted.org/packages/f9/42/8751c5f58ae59b09e070da4fa322ae9693a340d2cc456b5a380b2c1ee47a/pyftpdlib-2.2.0.tar.gz",timeout=30).read(); assert hashlib.sha256(data).hexdigest()=="4ba0642078792df63dd3b2e9c8f838f2a3ecf428c7518d5921c0530d53512acf"; pathlib.Path("/fixture/server.tar.gz").write_bytes(data)'
RUN mkdir /fixture/library && tar -xzf /fixture/server.tar.gz --strip-components=1 -C /fixture/library && rm /fixture/server.tar.gz
COPY server.py /fixture/server.py
ENV PYTHONPATH=/fixture/library PYTHONUNBUFFERED=1
USER 65534:65534
EXPOSE 2121 30000
CMD ["python", "/fixture/server.py"]
