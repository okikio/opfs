import { execFileSync } from "node:child_process";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";
import { seafileCurl } from "./seafile-curl.ts";

/** Official immutable CE14 AMD64 manifest; packaged runtime version is checked by the provider test. */
export const SEAFILE_IMAGE =
  "seafileltd/seafile-mc:14.0-latest@sha256:61cabec327c2401258cf814a3c5aaa7323d07ef02551bb032508a263d5c874a4";
const DATABASE_IMAGE = "mariadb:10.11.15@sha256:85c39719200637250bb8abe3ccd239239d6f175156fc1698141409fcf8e01a38";
const REDIS_IMAGE = "redis:7.4.7-alpine@sha256:02f2cc4882f8bf87c79a220ac958f58c700bdec0dfb9b9ea61b62fb0e8f1bfcf";
const EMAIL = "fixture@example.test", PASSWORD = "fixture-password-123456";
/** Owns all three disposable services and the private network. Consumers borrow only endpoint and explicit token. */
export class SeafileFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly token: string;
  readonly #resources: readonly (() => Promise<unknown>)[];
  #closure: Promise<void> | undefined;
  constructor(server: StartedTestContainer, token: string, resources: readonly (() => Promise<unknown>)[]) {
    this.token = token;
    this.#resources = resources;
    this.endpoint = `http://${server.getHost()}:${server.getMappedPort(80)}/`;
  }
  async oracle(operation: string, ...args: string[]): Promise<unknown> {
    return seafileCurl(this.endpoint, this.token, operation, args);
  }

  close(): Promise<void> {
    return this.#closure ??= close([...this.#resources].reverse());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Testcontainers owns native readiness, ephemeral ports, finite quotas and reverse-order partial cleanup. */
export async function startSeafile(): Promise<SeafileFixture> {
  const { BoundPorts, GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
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
