/** Configures an independent native ProFTPD process; it implements no FTP commands. */
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process, { getgid, getuid, stdout } from "node:process";

if (typeof getuid !== "function" || typeof getgid !== "function" || getuid() !== 65534 || getgid() !== 65534) {
  throw new Error("FTP fixture requires a POSIX runtime running as UID/GID 65534.");
}
const HOME = "/tmp/ftp-home";
mkdirSync(HOME);
mkdirSync("/tmp/ftp-control", { mode: 0o700 });

/** Only fixed native setup commands run here, each with finite captured output. */
function run(command: string, args: readonly string[]): Buffer {
  const child = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024,
  });
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(
      JSON.stringify({
        command,
        args,
        status: child.status,
        signal: child.signal,
        stderr: child.stderr?.toString(),
        error: child.error?.message,
      }),
    );
  }
  return child.stdout;
}
run("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-noenc",
  "-keyout",
  "/tmp/ftp-control/key.pem",
  "-out",
  "/tmp/ftp-control/cert.pem",
  "-days",
  "1",
  "-subj",
  "/CN=localhost",
  "-addext",
  "subjectAltName=DNS:localhost,IP:127.0.0.1",
  "-addext",
  "basicConstraints=critical,CA:TRUE,pathlen:0",
]);
const password = run("openssl", ["passwd", "-6", "test-only-password"]).toString().trim();
writeFileSync("/tmp/ftp-control/passwd", `fixture:${password}:65534:65534:fixture:${HOME}:/bin/false\n`, {
  mode: 0o600,
  flag: "wx",
});
writeFileSync("/tmp/ftp-control/group", "fixture:x:65534:fixture\n", { mode: 0o600, flag: "wx" });

// Native directory rules restrict file operations; this nonroot profile has no
// chroot or virtual root. PWD exposes the actual container home pathname.
const configuration = `ServerName "OPFS native FTP fixture"
ServerType standalone
DefaultServer on
UseIPv6 off
Port 2121
User nobody
Group nogroup
UseReverseDNS off
RequireValidShell off
AuthOrder mod_auth_file.c
AuthUserFile /tmp/ftp-control/passwd
AuthGroupFile /tmp/ftp-control/group
PidFile /tmp/ftp-control/pid
ScoreboardFile /tmp/ftp-control/scoreboard
WtmpLog off
TransferLog NONE
TimeoutIdle 30
TimeoutNoTransfer 30
TimeoutStalled 30
MaxInstances 8
PassivePorts 30000 30001
AllowOverwrite on
ModulePath /usr/lib/proftpd
LoadModule mod_tls.c
<IfModule mod_auth_pam.c>
  AuthPAM off
</IfModule>
<IfModule mod_delay.c>
  DelayEngine off
</IfModule>
TLSEngine on
TLSProtocol TLSv1.2
TLSRequired off
TLSVerifyClient off
TLSRSACertificateFile /tmp/ftp-control/cert.pem
TLSRSACertificateKeyFile /tmp/ftp-control/key.pem
TLSRenegotiate none
<Directory />
  AllowOverride off
  <Limit DIRS READ WRITE>
    DenyAll
  </Limit>
</Directory>
<Directory ${HOME}>
  <Limit DIRS READ WRITE>
    AllowAll
  </Limit>
</Directory>
`;
writeFileSync("/tmp/ftp-control/conf", configuration, { mode: 0o600, flag: "wx" });
// Do not add NoSessionReuseRequired: mod_tls must retain its default binding
// between authenticated control and private data TLS sessions.
const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const provenance = {
  profile: "native ProFTPD, UID/GID65534, real container PWD, directory operation limits, TLS1.2 session reuse",
  versions: {
    proftpd: run("/usr/sbin/proftpd", ["-V"]).toString(),
    openssl: run("openssl", ["version"]).toString(),
    curl: run("curl", ["--version"]).toString(),
  },
  hashes: Object.fromEntries(
    [
      "/usr/sbin/proftpd",
      "/usr/bin/openssl",
      "/usr/bin/curl",
      "/usr/lib/proftpd/mod_tls.so",
      "/fixture/server.ts",
      "/fixture/client.ts",
      "/tmp/ftp-control/conf",
    ].map((path) => [path, hash(path)]),
  ),
  packages: readFileSync("/fixture/receipts/packages.txt", "utf8"),
  debs: readFileSync("/fixture/receipts/debs.sha256", "utf8"),
};
writeFileSync("/tmp/ftp-provenance.json", JSON.stringify(provenance), { flag: "wx" });
run("/usr/sbin/proftpd", ["-t", "-c", "/tmp/ftp-control/conf"]);
const server = spawn("/usr/sbin/proftpd", ["-n", "-c", "/tmp/ftp-control/conf"], {
  stdio: ["ignore", "ignore", "pipe"],
});
let observed = 0, pending = "", ready = false;
server.stderr.on("data", (bytes: Buffer) => {
  observed += bytes.length;
  if (observed > 2 * 1024 * 1024) {
    server.kill("SIGKILL");
    throw new Error("Native FTP diagnostics exceed 2 MiB.");
  }
  stdout.write(bytes);
  pending = (pending + bytes.toString()).slice(-4096);
  // Upstream emits this marker after native listener bindings initialize.
  if (!ready && pending.includes("standalone mode STARTUP")) {
    ready = true;
    stdout.write("OPFS FTP fixture ready\n");
  }
});
server.once("error", (reason) => {
  throw reason;
});
server.once("exit", (code, signal) => {
  if (code !== 0 || signal !== null) throw new Error(`Native FTP server exited: ${code}/${signal}`);
});
process.on("SIGTERM", () => {
  server.kill("SIGTERM");
});
process.on("SIGINT", () => {
  server.kill("SIGINT");
});
