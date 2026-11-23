"""Independent pyftpdlib server; no candidate TypeScript parser or storage code."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import ipaddress

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from OpenSSL import SSL
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import FTPServer

home = Path("/tmp/ftp-home")
home.mkdir()
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
now = datetime.now(timezone.utc)
certificate = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(subject)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - timedelta(minutes=5))
    .not_valid_after(now + timedelta(days=1))
    .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
    .add_extension(x509.SubjectAlternativeName([
        x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))
    ]), critical=False)
    .sign(key, hashes.SHA256())
)
certfile = "/tmp/ftp-cert.pem"
keyfile = "/tmp/ftp-key.pem"
Path(certfile).write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
Path(keyfile).write_bytes(key.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
))
context = SSL.Context(SSL.TLS_SERVER_METHOD)
# This fixture specifically proves TLS1.2 session reuse, not all TLS versions.
context.set_min_proto_version(SSL.TLS1_2_VERSION)
context.set_max_proto_version(SSL.TLS1_2_VERSION)
context.use_certificate_file(certfile)
context.use_privatekey_file(keyfile)
context.set_session_id(b"opfs-ftp-fixture")
context.set_session_cache_mode(SSL.SESS_CACHE_SERVER)

authorizer = DummyAuthorizer()
authorizer.add_user("fixture", "test-only-password", str(home), perm="elradfmwMT")

class Handler(TLS_FTPHandler):
    pass

Handler.authorizer = authorizer
Handler.certfile = certfile
Handler.keyfile = keyfile
Handler.ssl_context = context
Handler.passive_ports = [30000]
Handler.timeout = 30
server = FTPServer(("0.0.0.0", 2121), Handler)
print("OPFS FTP fixture ready", flush=True)
server.serve_forever()
