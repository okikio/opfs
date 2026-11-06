import type { StartedTestContainer } from "testcontainers";

import { close } from "../../src/close.ts";

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
    return this.#closure ??= close([
      async () => {
        const { getContainerRuntimeClient } = await import("testcontainers");
        const runtime = await getContainerRuntimeClient();
        const value = await runtime.container.getById(this.#container.getId()).inspect();
        console.log(
          JSON.stringify({ phase: "gcs-before-owned-removal", id: this.#container.getId(), state: value.State }),
        );
        if (value.State.OOMKilled) throw new Error("Native GCS fixture was OOM-killed.");
      },
      async () => {
        await this.#container.stop();
      },
    ]);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** SDK host discovery and Docker acquisition occur only through this explicit call. */
export async function openGcs(): Promise<GcsFixture> {
  const { GenericContainer, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient();
  let created: string | undefined;
  /** Admit actual resource settings before engine start, including on a fresh image pull. */
  class NativeContainer extends GenericContainer {
    constructor() {
      super(GCS_IMAGE);
      this.hostConfig.MemorySwap = 536870912;
      this.hostConfig.PidsLimit = 128;
    }
    protected override async containerCreated(id: string): Promise<void> {
      created = id;
      const value = await runtime.container.getById(id).inspect();
      const host = value.HostConfig;
      console.log(
        JSON.stringify({
          phase: "gcs-created-before-start",
          id,
          image: value.Image,
          host,
          mounts: value.Mounts,
          state: value.State,
        }),
      );
      if (
        host.Memory !== 536870912 || host.MemorySwap !== 536870912 || host.NanoCpus !== 1000000000 ||
        host.PidsLimit !== 128 || host.Privileged || host.Binds?.length || value.Mounts.length ||
        value.State.Status !== "created" || value.State.Running || value.Config.Image !== GCS_IMAGE
      ) {
        throw new Error("Actual GCS fixture resource admission differs.");
      }
    }
  }
  let container: StartedTestContainer;
  try {
    container = await new NativeContainer()
      .withCommand(["-scheme", "http", "-backend", "memory"])
      .withExposedPorts(PORT)
      .withResourcesQuota({ memory: 0.5, cpu: 1 })
      .withDroppedCapabilities("ALL")
      .withSecurityOpt("no-new-privileges")
      .withWaitStrategy(Wait.forHttp("/storage/v1/b", PORT).forStatusCode(200))
      .withStartupTimeout(90_000)
      .start();
  } catch (reason) {
    // Registration precedes admission and engine start, so failed starts remain owned.
    await close([async () => {
      if (created === undefined) return;
      try {
        await runtime.container.getById(created).remove({ force: true, v: true });
      } catch (cleanup) {
        if (
          cleanup === null || typeof cleanup !== "object" || !("statusCode" in cleanup) || cleanup.statusCode !== 404
        ) {
          throw cleanup;
        }
      }
    }], [reason]);
    throw reason;
  }
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
