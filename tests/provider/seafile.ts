import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Official immutable CE14 AMD64 manifest; packaged runtime version is checked by the provider test. */
export const SEAFILE_IMAGE =
  "seafileltd/seafile-mc:14.0-latest@sha256:61cabec327c2401258cf814a3c5aaa7323d07ef02551bb032508a263d5c874a4";
const DATABASE_IMAGE = "mariadb:10.11.15@sha256:85c39719200637250bb8abe3ccd239239d6f175156fc1698141409fcf8e01a38";
const REDIS_IMAGE = "redis:7.4.7-alpine@sha256:02f2cc4882f8bf87c79a220ac958f58c700bdec0dfb9b9ea61b62fb0e8f1bfcf";
const EMAIL = "fixture@example.test", PASSWORD = "fixture-password-123456";
const WHEELS: readonly (readonly [string, string])[] = [
  [
    "https://files.pythonhosted.org/packages/2f/e7/bc61fb1f727f4f1538c535a3babc969570a833e766aeec7672e1a421f2b1/seafileapi2-2.0.2-py3-none-any.whl",
    "a174a9f1b4cbe737b353b11c7158f6aa23bc5ed59d65e2e338bdf30132965bed",
  ],
  [
    "https://files.pythonhosted.org/packages/a0/f4/c67b0b3f1b9245e8d266f0f112c500d50e5b4e83cb6f3b71b6528104182a/requests-2.34.2-py3-none-any.whl",
    "2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0",
  ],
  [
    "https://files.pythonhosted.org/packages/fc/ad/d07d7862a62ffa6d79d68074d14823243dd235a77c45262acbf6adeb28bf/charset_normalizer-3.5.2-py3-none-any.whl",
    "b6b751274acb69d77b3323d6b7dbaa3c7fdfc1eb829b7eb61d262f32e1af9685",
  ],
  [
    "https://files.pythonhosted.org/packages/58/a2/bb081bab032533a855d44de1d56f8e8426114ff1ba5d1f07a438a0a654f8/idna-3.20-py3-none-any.whl",
    "ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c",
  ],
  [
    "https://files.pythonhosted.org/packages/92/9d/c4e665119135114480843e7ab388fa94d8480650450e6f8e26b70d323a4c/urllib3-2.8.0-py3-none-any.whl",
    "0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3",
  ],
  [
    "https://files.pythonhosted.org/packages/32/d1/a3652fe2c19134d0d15922177821d863cbd7e842d53a21bbe7e8e3a1b5ac/certifi-2026.10.23-py3-none-any.whl",
    "e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1",
  ],
];
/** Test-only official SDK imported directly from hash-pinned pure-Python wheels; no global pip installation. */
const oracle = `import sys, os, json, base64
sys.path[:0] = sorted('/tmp/' + name for name in os.listdir('/tmp') if name.endswith('.whl'))
import requests
from seafileapi import SeafileAPI
assert requests.__version__ == '2.34.2'
public = sys.argv[1]
# Only the exact ephemeral fixture authority maps to the service's own loopback listener.
# Path, query and headers are preserved, and production code never uses this adapter.
original = requests.sessions.Session.request
def request(self, method, url, *args, **kwargs):
    if url.startswith(public):
        url = 'http://127.0.0.1/' + url[len(public):]
    kwargs.setdefault('timeout', 30)
    return original(self, method, url, *args, **kwargs)
requests.sessions.Session.request = request
api = SeafileAPI.from_auth_token(sys.argv[2], public)
api.auth()
operation = sys.argv[3]
if operation == 'create':
    repo = api.create_repo(sys.argv[4], passwd=sys.argv[5] if len(sys.argv) > 5 else None)
    print(json.dumps({'id': repo.repo_id}))
else:
    repo = api.get_repo(sys.argv[4])
    if operation == 'upload':
        with open('/tmp/oracle-input', 'wb') as output: output.write(base64.b64decode(sys.argv[5]))
        print(json.dumps(repo.upload_file('/', '/tmp/oracle-input')))
    elif operation == 'read':
        repo.download_file(sys.argv[5], '/tmp/oracle-output')
        with open('/tmp/oracle-output', 'rb') as source: print(json.dumps({'bytes': base64.b64encode(source.read()).decode('ascii')}))
`;

/** Owns all three disposable services and the private network. Consumers borrow only endpoint and explicit token. */
export class SeafileFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly token: string;
  readonly #server: StartedTestContainer;
  readonly #resources: readonly (() => Promise<unknown>)[];
  #closure: Promise<void> | undefined;
  constructor(server: StartedTestContainer, token: string, resources: readonly (() => Promise<unknown>)[]) {
    this.#server = server;
    this.token = token;
    this.#resources = resources;
    this.endpoint = `http://${server.getHost()}:${server.getMappedPort(80)}/`;
  }
  async oracle(operation: string, ...args: string[]): Promise<unknown> {
    const result = await this.#server.exec([
      "python3",
      "/tmp/seafile-oracle.py",
      this.endpoint,
      this.token,
      operation,
      ...args,
    ]);
    if (result.exitCode !== 0) throw new Error(`Official Seafile SDK failed: ${result.output}`);
    try {
      return JSON.parse(result.output.trim()) as unknown;
    } catch {
      throw new Error("Official Seafile SDK returned malformed oracle output.");
    }
  }
  close(): Promise<void> {
    return this.#closure ??= close([...this.#resources].reverse());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Bounded dependency downloads verify exact wheel bytes before copying anything into the disposable server. */
async function wheels(): Promise<{ content: Buffer; target: string }[]> {
  const files: { content: Buffer; target: string }[] = [];
  for (const [url, digest] of WHEELS) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Seafile oracle wheel acquisition failed with HTTP ${response.status}.`);
    const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 2 * 1024 * 1024) throw new Error("Seafile oracle wheel exceeds its artifact bound.");
        chunks.push(next.value);
      }
    } catch (reason) {
      await close([() => reader.cancel(reason), () => reader.releaseLock()], [reason]);
      throw reason;
    }
    reader.releaseLock();
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error("Seafile oracle wheel digest differs from its pin.");
    }
    files.push({ content: bytes, target: `/tmp/${new URL(url).pathname.split("/").at(-1)}` });
  }
  return files;
}

/** Testcontainers owns native readiness, ephemeral ports, finite quotas and reverse-order partial cleanup. */
export async function startSeafile(): Promise<SeafileFixture> {
  const { BoundPorts, GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const artifacts = await wheels();
  const resources: (() => Promise<unknown>)[] = [];
  let network: StartedNetwork;
  let nativeId: string | undefined;
  // Capture early native entrypoint failure before Ryuk removes the failed-start container.
  class NativeContainer extends GenericContainer {
    protected override containerCreated(id: string): Promise<void> {
      nativeId = id;
      return Promise.resolve();
    }
  }
  try {
    network = await new Network().start();
    resources.push(() => network.stop());
    const database = await new GenericContainer(DATABASE_IMAGE).withNetwork(network).withNetworkAliases("db")
      .withEnvironment({ MARIADB_ROOT_PASSWORD: PASSWORD, MARIADB_ROOT_HOST: "%" })
      .withResourcesQuota({ memory: 0.5, cpu: 0.5 })
      .withHealthCheck({
        test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
        interval: 1000,
        timeout: 3000,
        retries: 90,
        startPeriod: 1000,
      })
      .withWaitStrategy(Wait.forHealthCheck()).withStartupTimeout(120_000).start();
    resources.push(() => database.stop());
    const redis = await new GenericContainer(REDIS_IMAGE).withNetwork(network).withNetworkAliases("redis")
      .withCommand(["redis-server", "--requirepass", PASSWORD, "--save", "", "--appendonly", "no"])
      .withResourcesQuota({ memory: 0.125, cpu: 0.25 })
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections")).withStartupTimeout(60_000).start();
    resources.push(() => redis.stop());
    const server = await new NativeContainer(SEAFILE_IMAGE).withPlatform("linux/amd64").withNetwork(network)
      .withNetworkAliases("seafile.test")
      .withEnvironment({
        SEAFILE_MYSQL_DB_HOST: "db",
        SEAFILE_MYSQL_DB_USER: "seafile",
        SEAFILE_MYSQL_DB_PORT: "3306",
        SEAFILE_MYSQL_DB_CCNET_DB_NAME: "ccnet_db",
        SEAFILE_MYSQL_DB_SEAFILE_DB_NAME: "seafile_db",
        SEAFILE_MYSQL_DB_SEAHUB_DB_NAME: "seahub_db",
        SEAFILE_MYSQL_DB_PASSWORD: PASSWORD,
        INIT_SEAFILE_MYSQL_ROOT_PASSWORD: PASSWORD,
        INIT_SEAFILE_ADMIN_EMAIL: EMAIL,
        INIT_SEAFILE_ADMIN_PASSWORD: PASSWORD,
        SEAFILE_SERVER_HOSTNAME: "seafile.test",
        SEAFILE_SERVER_PROTOCOL: "http",
        SITE_ROOT: "/",
        NON_ROOT: "false",
        ENABLE_GO_FILESERVER: "true",
        ENABLE_SEAFDAV: "false",
        JWT_PRIVATE_KEY: "fixture-jwt-private-key-with-at-least-32-characters",
        CACHE_PROVIDER: "redis",
        REDIS_HOST: "redis",
        REDIS_PORT: "6379",
        REDIS_PASSWORD: PASSWORD,
        ENABLE_SEADOC: "false",
        ENABLE_NOTIFICATION_SERVER: "false",
        ENABLE_SEAFILE_AI: "false",
        ENABLE_METADATA_MANAGEMENT: "false",
        SEAFILE_LOG_TO_STDOUT: "true",
        TIME_ZONE: "Etc/UTC",
      })
      .withCopyContentToContainer([...artifacts, { content: Buffer.from(oracle), target: "/tmp/seafile-oracle.py" }])
      .withExposedPorts(80).withResourcesQuota({ memory: 2, cpu: 1 })
      .withLogConsumer((stream) => {
        stream.on("data", (chunk) => console.error("Seafile bootstrap:", String(chunk).trim()));
        stream.on("err", (chunk) => console.error("Seafile bootstrap:", String(chunk).trim()));
      })
      .withWaitStrategy(Wait.forHttp("/api2/server-info/", 80).forStatusCode(200)).withStartupTimeout(180_000).start();
    resources.push(() => server.stop());
    const endpoint = `http://${server.getHost()}:${server.getMappedPort(80)}/`;
    // CE14 applies the hostname environment after local settings, so scope the actual mapped authority to Seahub.
    const environment = { SEAFILE_SERVER_HOSTNAME: new URL(endpoint).host };
    const runtime = await getContainerRuntimeClient(), ports = new BoundPorts();
    const native = runtime.container.getById(server.getId());
    const restart = ["timeout", "60", "/opt/seafile/seafile-server-14.0.9/seahub.sh", "restart"];
    let restarted = await server.exec(restart, { env: environment });
    // This pinned script permits only one second for TERM. Slow emulation can require its graceful stop to settle.
    if (restarted.exitCode === 1 && restarted.output.includes("Failed to stop seahub.")) {
      console.info("Seafile native restart requires graceful-stop completion:", restarted.exitCode, restarted.output);
      await Wait.forSuccessfulCommand("! pgrep -f '[t]hirdpart/bin/gunicorn'").withStartupTimeout(60_000)
        .waitUntilReady(native);
      restarted = await server.exec(restart, { env: environment });
    }
    if (restarted.exitCode !== 0) throw new Error(`Seafile native Seahub restart failed: ${restarted.output}`);
    console.info("Seafile native Seahub restart acknowledged:", restarted.exitCode);
    // The pinned script checks only its process. Reuse Testcontainers' public HTTP strategy for actual readiness.
    ports.setBinding(80, server.getMappedPort(80));
    await Wait.forHttp("/api2/server-info/", 80, { abortOnContainerExit: true }).forStatusCode(200)
      .withStartupTimeout(60_000).waitUntilReady(runtime.container.getById(server.getId()), ports);
    const response = await fetch(new URL("api2/auth-token/", endpoint), {
      method: "POST",
      body: new URLSearchParams({ username: EMAIL, password: PASSWORD }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const data: unknown = await response.json();
    if (
      !response.ok || typeof data !== "object" || data === null || !("token" in data) || typeof data.token !== "string"
    ) throw new Error(`Seafile native authentication setup failed with HTTP ${response.status}.`);
    return new SeafileFixture(server, data.token, resources);
  } catch (reason) {
    if (nativeId !== undefined) {
      try {
        console.error(
          "Seafile failed bootstrap:",
          execFileSync("docker", ["logs", nativeId], {
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          }),
        );
      } catch (diagnostic) {
        console.error("Seafile bootstrap diagnostic unavailable:", diagnostic);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
