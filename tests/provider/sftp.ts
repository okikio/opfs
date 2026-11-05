import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { StartedTestContainer } from "testcontainers";
import type { SftpOptionsType } from "../../src/sftp.ts";
import { close } from "../close.ts";

/** Maintainer's OpenSSH image index inspected with buildx on 2026-11-05. */
export const SFTP_IMAGE =
  "lscr.io/linuxserver/openssh-server@sha256:0b46c755aac07057908077f2c7ff14f0ad923970bb6a3a67bcd008e72fa60050";
export const SFTP_ROOT = "/tmp/files";
export const SFTP_BYTES = "independent OpenSSH sftp producer bytes";
/** No host data, ambient keys or passwords enter this isolated SSH fixture. */
const START = `set -eu
mkdir -p /run/sshd /tmp/files /root/.ssh
ssh-keygen -q -t ed25519 -N '' -f /tmp/server_key
ssh-keygen -q -t ed25519 -N '' -f /tmp/client_key
cp /tmp/client_key.pub /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
passwd -d root >/dev/null
awk '{print "[127.0.0.1]:2222 "$1" "$2}' /tmp/server_key.pub > /tmp/known_hosts
cat > /tmp/sshd.conf <<'CONFIG'
Port 2222
ListenAddress 0.0.0.0
HostKey /tmp/server_key
PidFile /tmp/sshd.pid
AuthorizedKeysFile /root/.ssh/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
UsePAM no
StrictModes yes
UseDNS no
PrintMotd no
LogLevel ERROR
Subsystem sftp internal-sftp
CONFIG
exec /usr/sbin/sshd.pam -D -e -f /tmp/sshd.conf`;

const SSH = [
  "-p",
  "2222",
  "-i",
  "/tmp/client_key",
  "-o",
  "BatchMode=yes",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "UserKnownHostsFile=/tmp/known_hosts",
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=5",
];
/** Entire SSH transport lives inside the fixture; only subsystem bytes cross stdout. */
export class SftpFixture implements AsyncDisposable {
  readonly #container: StartedTestContainer;
  readonly #channels = new Set<() => Promise<void>>();
  #closing: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
  }
  close(): Promise<void> {
    return this.#closing ??= close([...this.#channels, () => this.#container.stop()]);
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** Native OpenSSH client verifies a fixture-owned host key before starting sftp. */
  options(trust = true): SftpOptionsType {
    return {
      timeoutMs: 10_000,
      openChannel: ({ signal }) => {
        signal.throwIfAborted();
        const pid = `/tmp/ssh-${randomUUID()}.pid`;
        const ssh = trust ? SSH : [...SSH, "-o", "HostKeyAlias=wrong-host-key"];
        const child = spawn("docker", [
          "exec",
          "-i",
          this.#container.getId(),
          "sh",
          "-c",
          'echo $$ > "$1"; shift; exec "$@"',
          "--",
          pid,
          "ssh",
          ...ssh,
          "-s",
          "root@127.0.0.1",
          "sftp",
        ], { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = 0;
        child.stderr.on("data", (bytes: Uint8Array) => {
          stderr += bytes.length;
          if (stderr > 65536) child.kill("SIGKILL");
        });
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        exited.catch(() => {});
        let closing: Promise<void> | undefined;
        const release = () =>
          closing ??= Promise.resolve().then(async () => {
            signal.removeEventListener("abort", aborted);
            child.stdin.end();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                exited,
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new Error("SSH fixture channel did not exit.")), 3000);
                }),
              ]);
            } catch (reason) {
              child.kill("SIGKILL");
              await close([async () => {
                await this.#container.exec([
                  "sh",
                  "-c",
                  'if test -f "$1"; then kill "$(cat "$1")" 2>/dev/null || true; fi',
                  "--",
                  pid,
                ]);
              }], [reason]);
            } finally {
              if (timer) clearTimeout(timer);
              this.#channels.delete(release);
            }
          });
        const aborted = () => {
          release().catch(() => {});
        };
        signal.addEventListener("abort", aborted, { once: true });
        this.#channels.add(release);
        // The candidate owns frame validation; this adapter owns native SSH IO.
        return Promise.resolve({
          readable: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
          writable: new WritableStream<Uint8Array>({
            write(bytes) {
              // INIT dispatch proves the client acquired this channel. Its open
              // deadline must not later retire a successfully borrowed session.
              signal.removeEventListener("abort", aborted);
              return new Promise<void>((resolve, reject) => {
                child.stdin.write(bytes, (reason) => reason ? reject(reason) : resolve());
              });
            },
          }),
          close: release,
        });
      },
    };
  }
  /** OpenSSH's independent sftp CLI uploads, rather than the candidate packet encoder. */
  async seed(): Promise<void> {
    const result = await this.#container.exec([
      "sh",
      "-c",
      `printf '%s' '${SFTP_BYTES}' > /tmp/producer
printf 'put /tmp/producer ${SFTP_ROOT}/producer.txt\nmkdir ${SFTP_ROOT}/folder\n' > /tmp/seed.batch
exec sftp -b /tmp/seed.batch -P 2222 -i /tmp/client_key -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/known_hosts root@127.0.0.1`,
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent SFTP producer failed: ${result.output}`);
  }
  /** Fixed receipt path prevents a test filename from becoming a batch-command injection. */
  async receipt(): Promise<string> {
    const result = await this.#container.exec([
      "sh",
      "-c",
      `printf 'get ${SFTP_ROOT}/candidate.txt /tmp/receipt\n' > /tmp/read.batch
sftp -q -b /tmp/read.batch -P 2222 -i /tmp/client_key -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/known_hosts root@127.0.0.1 >/dev/null
cat /tmp/receipt`,
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent SFTP receipt failed: ${result.output}`);
    return result.stdout;
  }
}

export async function openSftp(): Promise<SftpFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer(SFTP_IMAGE)
    .withEntrypoint(["/bin/sh"]).withCommand(["-c", START])
    .withExposedPorts(2222).withSecurityOpt("no-new-privileges")
    .withResourcesQuota({ memory: 0.5, cpu: 1 })
    .withWaitStrategy(Wait.forListeningPorts()).withStartupTimeout(90_000).start();
  const fixture = new SftpFixture(container);
  try {
    await fixture.seed();
    return fixture;
  } catch (reason) {
    await close([() => fixture.close()], [reason]);
    throw reason;
  }
}
