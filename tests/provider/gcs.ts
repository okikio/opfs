import type { StartedTestContainer } from "testcontainers";

/** Immutable multi-architecture fake-gcs-server 1.56.1 image inspected on 2026-11-05. */
export const GCS_IMAGE =
  "docker.io/fsouza/fake-gcs-server:1.56.1@sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef";
/** Isolated emulator namespace; no Google Cloud account or credentials are used. */
export const GCS_BUCKET = "opfs-test";
const PORT = 4443;

/** Owns one Testcontainers service; all consumers borrow its endpoint. */
export class GcsFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;

  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
  }

  /** Concurrent disposal shares actual cleanup completion and failure. */
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** SDK host discovery and Docker acquisition occur only through this explicit call. */
export async function openGcs(): Promise<GcsFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer(GCS_IMAGE)
    .withCommand(["-scheme", "http", "-backend", "memory"])
    .withExposedPorts(PORT)
    .withResourcesQuota({ memory: 0.5, cpu: 1 })
    .withDroppedCapabilities("ALL")
    .withSecurityOpt("no-new-privileges")
    .withWaitStrategy(Wait.forHttp("/storage/v1/b", PORT).forStatusCode(200))
    .withStartupTimeout(90_000)
    .start();
  try {
    const fixture = new GcsFixture(container);
    const response = await fetch(`${fixture.endpoint}/storage/v1/b?project=opfs-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: GCS_BUCKET, versioning: { enabled: true } }),
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`GCS fixture bucket creation failed with HTTP ${response.status}.`);
    return fixture;
  } catch (reason) {
    try {
      await container.stop();
    } catch (cleanup) {
      throw new AggregateError([reason, cleanup], "GCS fixture construction and cleanup failed.", { cause: reason });
    }
    throw reason;
  }
}
