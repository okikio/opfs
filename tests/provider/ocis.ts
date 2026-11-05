import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";
import { readResponse } from "../../src/response.ts";

/** Official released multiarchitecture images; no image is selected by a mutable tag alone. */
export const OCIS_IMAGE = "owncloud/ocis:8.2.2@sha256:0367455bbde082e17f40bff5b906eb554c13d9a6e86134734a982239c5692383";
const RCLONE_IMAGE = "rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5";
const PASSWORD = "fixture-password-123456", USER = "admin";
const PORT = 9200;
const CLI_OPTIONS = [
  "--config",
  "/dev/null",
  "--retries",
  "1",
  "--low-level-retries",
  "1",
  "--contimeout",
  "10s",
  "--timeout",
  "20s",
];

/** One owned space and independent rclone oracle. Both services and their network are disposable. */
export class OcisFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly authorization: string;
  readonly space: string;
  readonly version: string;
  readonly #tool: StartedTestContainer;
  readonly #environment: Record<string, string>;
  readonly #resources: readonly (() => Promise<unknown>)[];
  #closure: Promise<void> | undefined;
  constructor(
    endpoint: string,
    space: string,
    version: string,
    tool: StartedTestContainer,
    environment: Record<string, string>,
    resources: readonly (() => Promise<unknown>)[],
  ) {
    this.endpoint = endpoint;
    this.space = space;
    this.version = version;
    this.authorization = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
    this.#tool = tool;
    this.#environment = { ...environment };
    this.#resources = [...resources];
  }
  /** The independent CLI reads/writes the same space through its private service authority. */
  async #run(args: string[]): Promise<void> {
    const result = await this.#tool.exec(["timeout", "60", "rclone", ...args, ...CLI_OPTIONS], {
      env: this.#environment,
    });
    if (result.exitCode !== 0) throw new Error(`Independent rclone operation failed: ${result.output}`);
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 1024 * 1024) throw new RangeError("OCIS oracle fixture bytes exceed their finite policy.");
    await this.#tool.copyContentToContainer([{ content: Buffer.from(bytes), target: "/tmp/ocis-input" }]);
    await this.#run(["copyto", "/tmp/ocis-input", `oracle:${path}`]);
  }
  async read(path: string): Promise<Uint8Array<ArrayBuffer>> {
    await this.#run(["copyto", `oracle:${path}`, "/tmp/ocis-output"]);
    const result = await this.#tool.exec(["base64", "/tmp/ocis-output"]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1024 * 1024) {
      throw new Error("Independent rclone output exceeded the fixture byte policy.");
    }
    return new Uint8Array(Buffer.from(result.output.replace(/\s/gu, ""), "base64"));
  }
  close(): Promise<void> {
    return this.#closure ??= close([...this.#resources].reverse());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Native initialization owns its configuration; Testcontainers owns readiness, ports, quotas and teardown. */
export async function openOcis(): Promise<OcisFixture> {
  const { GenericContainer, Network, Wait } = await import("testcontainers");
  const resources: (() => Promise<unknown>)[] = [];
  let nativeId: string | undefined;
  class NativeContainer extends GenericContainer {
    protected override containerCreated(id: string): Promise<void> {
      nativeId = id;
      return Promise.resolve();
    }
  }
  try {
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new NativeContainer(OCIS_IMAGE).withNetwork(network).withNetworkAliases("ocis.test")
      .withEntrypoint(["/bin/sh"])
      .withCommand(["-c", 'ocis init --insecure true --admin-password "$IDM_ADMIN_PASSWORD" && exec ocis server'])
      .withEnvironment({
        OCIS_URL: "https://ocis.test",
        OCIS_INSECURE: "true",
        PROXY_TLS: "false",
        PROXY_HTTP_ADDR: `0.0.0.0:${PORT}`,
        PROXY_ENABLE_BASIC_AUTH: "true",
        GATEWAY_FRONTEND_PUBLIC_URL: `http://ocis.test:${PORT}`,
        IDM_ADMIN_PASSWORD: PASSWORD,
        IDM_CREATE_DEMO_USERS: "false",
        OCIS_LOG_LEVEL: "warn",
        OCIS_LOG_COLOR: "false",
        OCIS_LOG_PRETTY: "false",
      })
      .withExposedPorts(PORT).withResourcesQuota({ memory: 2, cpu: 1 })
      .withLogConsumer((stream) => {
        stream.on("data", (chunk) => console.error("OCIS bootstrap:", String(chunk).trim()));
        stream.on("err", (chunk) => console.error("OCIS bootstrap:", String(chunk).trim()));
      })
      .withWaitStrategy(Wait.forAll([
        Wait.forHttp("/status.php", PORT, { abortOnContainerExit: true }).forStatusCode(200),
        Wait.forHttp("/graph/v1.0/me/drives", PORT, { abortOnContainerExit: true })
          .withBasicCredentials(USER, PASSWORD).forStatusCode(200),
      ]))
      .withStartupTimeout(180_000).start();
    resources.push(() => server.stop());
    const version = await server.exec(["ocis", "version"]);
    if (version.exitCode !== 0 || !/\b8\.2\.2\b/u.test(version.output)) {
      throw new Error("The native OCIS fixture did not report release 8.2.2.");
    }
    const origin = `http://${server.getHost()}:${server.getMappedPort(PORT)}`;
    const authorization = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
    const response = await fetch(`${origin}/graph/v1.0/me/drives`, {
      headers: { authorization },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const data = await readResponse(response, async (body) => {
      if (!response.ok) throw new Error(`Native OCIS fixture space selection failed with HTTP ${response.status}.`);
      return JSON.parse(await body()) as unknown;
    });
    if (typeof data !== "object" || data === null || !("value" in data) || !Array.isArray(data.value)) {
      throw new Error("Native OCIS fixture omitted its space listing.");
    }
    const personal: unknown[] = data.value.filter((value: unknown) =>
      typeof value === "object" && value !== null && "driveType" in value && value.driveType === "personal"
    );
    const selected = personal[0];
    if (
      personal.length !== 1 || typeof selected !== "object" || selected === null || !("id" in selected) ||
      typeof selected.id !== "string" || selected.id.length === 0 || selected.id.length > 1024 ||
      /[^!-~]|[\\/]/u.test(selected.id)
    ) throw new Error("Native OCIS fixture did not select one explicit personal-space ID.");
    const space = selected.id, suffix = `/dav/spaces/${encodeURIComponent(space)}/`;
    const tool = await new GenericContainer(RCLONE_IMAGE).withNetwork(network)
      .withEntrypoint(["/bin/sh"]).withCommand(["-c", "exec sleep 600"])
      .withResourcesQuota({ memory: 0.125, cpu: 0.25 })
      .withWaitStrategy(Wait.forSuccessfulCommand("rclone version")).withStartupTimeout(30_000).start();
    resources.push(() => tool.stop());
    const independent = await tool.exec(["rclone", "version"]);
    if (independent.exitCode !== 0 || !independent.output.startsWith("rclone v1.75.2")) {
      throw new Error("Independent OCIS oracle did not report pinned rclone 1.75.2.");
    }
    const obscured = await tool.exec(["rclone", "obscure", PASSWORD]);
    if (obscured.exitCode !== 0 || !/^[A-Za-z0-9_-]+\s*$/u.test(obscured.output)) {
      throw new Error("Independent rclone fixture credential setup failed.");
    }
    return new OcisFixture(`${origin}${suffix}`, space, version.output.trim(), tool, {
      RCLONE_CONFIG_ORACLE_TYPE: "webdav",
      RCLONE_CONFIG_ORACLE_VENDOR: "owncloud",
      RCLONE_CONFIG_ORACLE_URL: `http://ocis.test:${PORT}${suffix}`,
      RCLONE_CONFIG_ORACLE_USER: USER,
      RCLONE_CONFIG_ORACLE_PASS: obscured.output.trim(),
    }, resources);
  } catch (reason) {
    if (nativeId !== undefined) {
      try {
        console.error(
          "OCIS failed bootstrap:",
          execFileSync("docker", ["logs", nativeId], {
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          }),
        );
      } catch (diagnostic) {
        console.error("OCIS bootstrap diagnostic unavailable:", diagnostic);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
