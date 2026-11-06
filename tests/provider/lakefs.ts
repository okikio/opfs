import { Buffer } from "node:buffer";
import type { StartedTestContainer } from "testcontainers";

/** Native server and independent lakectl from the same immutable upstream release; test-only BSL1.1 software. */
export const LAKEFS_IMAGE =
  "treeverse/lakefs:1.88.0@sha256:237a17c6b2d85ba71912aaf82ac61f17dcb4c1884301ff4638bd3d55fa4cb4d0";
const KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
/** One disposable local backend. Its deliberate local-store configuration is not a production deployment recommendation. */
export class LakefsFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly authorization = `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`;
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.endpoint = `http://${container.getHost()}:${container.getMappedPort(8000)}/`;
  }
  async command(...args: string[]): Promise<string> {
    const result = await this.#container.exec(["lakectl", ...args]);
    if (result.exitCode !== 0) throw new Error(`Official lakectl failed: ${result.output}`);
    return result.output;
  }
  async put(bytes: Uint8Array): Promise<void> {
    const result = await this.#container.exec([
      "sh",
      "-c",
      'printf %s "$1" | base64 -d > /tmp/oracle-input && lakectl fs upload --source /tmp/oracle-input lakefs://fixture/main/from-cli.bin',
      "oracle",
      Buffer.from(bytes).toString("base64"),
    ]);
    if (result.exitCode !== 0) throw new Error(`Official lakectl upload failed: ${result.output}`);
  }
  async read(ref: string, path: string): Promise<Uint8Array<ArrayBuffer>> {
    const result = await this.#container.exec([
      "sh",
      "-c",
      'lakectl fs cat "$1" > /tmp/oracle-output && base64 /tmp/oracle-output',
      "oracle",
      `lakefs://fixture/${ref}/${path}`,
    ]);
    if (result.exitCode !== 0) throw new Error(`Official lakectl read failed: ${result.output}`);
    return new Uint8Array(Buffer.from(result.output.trim(), "base64"));
  }
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
/** Native HTTP readiness, ephemeral port, bounded resources, and cleanup even if repository initialization fails. */
export async function startLakefs(): Promise<LakefsFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer(LAKEFS_IMAGE)
    .withCommand(["run", "--local-settings"])
    .withEnvironment({
      LAKEFS_INSTALLATION_USER_NAME: "fixture",
      LAKEFS_INSTALLATION_ACCESS_KEY_ID: KEY,
      LAKEFS_INSTALLATION_SECRET_ACCESS_KEY: SECRET,
      LAKEFS_STATS_ENABLED: "false",
      LAKECTL_CREDENTIALS_ACCESS_KEY_ID: KEY,
      LAKECTL_CREDENTIALS_SECRET_ACCESS_KEY: SECRET,
      LAKECTL_SERVER_ENDPOINT_URL: "http://127.0.0.1:8000",
    })
    .withExposedPorts(8000).withResourcesQuota({ memory: 1, cpu: 1 })
    .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
    .withWaitStrategy(Wait.forHttp("/_health", 8000).forStatusCode(200))
    .withStartupTimeout(120_000).start();
  const fixture = new LakefsFixture(container);
  try {
    await fixture.command("repo", "create", "lakefs://fixture", "local://fixture", "--default-branch", "main");
    return fixture;
  } catch (reason) {
    try {
      await fixture.close();
    } catch (cleanup) {
      throw new AggregateError([reason, cleanup], "lakeFS fixture setup and cleanup failed.", { cause: reason });
    }
    throw reason;
  }
}
