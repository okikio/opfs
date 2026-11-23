import { Buffer } from "node:buffer";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Independently inspected multiarch release indexes; no floating image controls the fixture. */
export const RESTIC_SERVER_IMAGE =
  "restic/rest-server@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5";
export const RESTIC_CLI_IMAGE = "restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510";
export const RESTIC_ORACLE_BYTES = "official restic CLI producer encrypted pack bytes\n";

/** Native CLI/server owners are private to this disposable fixture, including passwords, network and repository state. */
export class ResticFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly appendEndpoint: string;
  readonly authorization = "Basic Zml4dHVyZTpmaXh0dXJlLXBhc3N3b3Jk";
  readonly #server: StartedTestContainer;
  readonly #append: StartedTestContainer;
  readonly #cli: StartedTestContainer;
  readonly #network: StartedNetwork;
  #closure: Promise<void> | undefined;
  constructor(
    server: StartedTestContainer,
    append: StartedTestContainer,
    cli: StartedTestContainer,
    network: StartedNetwork,
  ) {
    this.#server = server;
    this.#append = append;
    this.#cli = cli;
    this.#network = network;
    this.endpoint = `http://${server.getHost()}:${server.getMappedPort(8000)}/`;
    this.appendEndpoint = `http://${append.getHost()}:${append.getMappedPort(8000)}/`;
  }
  close(): Promise<void> {
    return this.#closure ??= close([
      () => this.#cli.stop(),
      () => this.#append.stop(),
      () => this.#server.stop(),
      () => this.#network.stop(),
    ]);
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /** Exact repo choices avoid arbitrary fixture shell or network targets. Native CLI owns cryptographic initialization. */
  #repository(repository: "source" | "destination" | "append"): string {
    return `rest:http://fixture:fixture-password@${repository === "append" ? "append" : "server"}:8000/${repository}/`;
  }
  async command(repository: "source" | "destination" | "append", ...args: string[]): Promise<void> {
    const result = await this.#cli.exec(["restic", "--no-cache", "-r", this.#repository(repository), ...args]);
    if (result.exitCode !== 0) throw new Error(`Official restic CLI failed: ${result.output}`);
  }
  /** The official CLI prints raw pack bytes; base64 only preserves binary bytes across exec's text channel. */
  async pack(repository: "source" | "destination" | "append", id: string): Promise<Uint8Array<ArrayBuffer>> {
    if (!/^[0-9a-f]{64}$/u.test(id)) throw new TypeError("Invalid fixture pack ID.");
    const result = await this.#cli.exec([
      "sh",
      "-c",
      'restic --no-cache -r "$1" cat pack "$2" > /tmp/oracle-pack && base64 /tmp/oracle-pack',
      "oracle",
      this.#repository(repository),
      id,
    ]);
    if (result.exitCode !== 0) throw new Error(`Official raw pack reader failed: ${result.output}`);
    return new Uint8Array(Buffer.from(result.output.trim(), "base64"));
  }
}

/** All partially acquired resources retire in reverse order, including failures during native user creation or CLI readiness. */
export async function startRestic(): Promise<ResticFixture> {
  const { GenericContainer, Network, Wait } = await import("testcontainers");
  const releases: Array<() => Promise<unknown>> = [];
  try {
    const network = await new Network().start();
    releases.push(() => network.stop());
    const server = await new GenericContainer(RESTIC_SERVER_IMAGE).withNetwork(network).withNetworkAliases("server")
      .withExposedPorts(8000).withResourcesQuota({ memory: 0.25, cpu: 0.5 })
      .withCommand([
        "sh",
        "-c",
        "umask 077; touch /data/.htpasswd && create_user fixture fixture-password && exec /entrypoint.sh",
      ])
      .withWaitStrategy(Wait.forHttp("/", 8000).forStatusCode(401)).withStartupTimeout(90_000).start();
    releases.push(() => server.stop());
    const append = await new GenericContainer(RESTIC_SERVER_IMAGE).withNetwork(network).withNetworkAliases("append")
      .withExposedPorts(8000).withResourcesQuota({ memory: 0.25, cpu: 0.5 }).withEnvironment({
        OPTIONS: "--append-only",
      })
      .withCommand([
        "sh",
        "-c",
        "umask 077; touch /data/.htpasswd && create_user fixture fixture-password && exec /entrypoint.sh",
      ])
      .withWaitStrategy(Wait.forHttp("/", 8000).forStatusCode(401)).withStartupTimeout(90_000).start();
    releases.push(() => append.stop());
    const cli = await new GenericContainer(RESTIC_CLI_IMAGE).withNetwork(network).withResourcesQuota({
      memory: 0.5,
      cpu: 1,
    })
      .withEnvironment({ RESTIC_PASSWORD: "fixture-repository-password", HOME: "/tmp/fixture-home" })
      .withCopyContentToContainer([{ content: RESTIC_ORACLE_BYTES, target: "/source/oracle.txt" }])
      .withEntrypoint(["sh", "-c"]).withCommand(["echo 'oracle ready'; exec tail -f /dev/null"])
      .withWaitStrategy(Wait.forLogMessage("oracle ready")).withStartupTimeout(90_000).start();
    releases.push(() => cli.stop());
    const fixture = new ResticFixture(server, append, cli, network);
    await fixture.command("source", "init");
    await fixture.command("source", "backup", "/source", "--host", "fixture");
    await fixture.command("destination", "init");
    await fixture.command("append", "init");
    return fixture;
  } catch (reason) {
    await close(releases.toReversed(), [reason]);
    throw reason;
  }
}
