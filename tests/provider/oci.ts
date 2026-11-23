import type { StartedTestContainer } from "testcontainers";

/** Official distribution registry 3.1.2 index, verified with buildx imagetools on 2026-11-05. */
export const OCI_IMAGE =
  "docker.io/library/registry@sha256:d4032d4cc323c1731c707931ecada07a53076eac38e3b61ae57533f170f2c6c3";
export const OCI_REPOSITORY = "opfs/protocol";
const PORT = 5000;
/** Fixture bytes are ordinary content, not a runnable image or an archive. */
export const OCI_BLOB = new TextEncoder().encode("independent registry fixture bytes");
const mediaType = "application/vnd.oci.image.manifest.v1+json";

/** Independent producer hashes raw bytes without using the candidate client's digest/parser code. */
async function digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")
  }`;
}
/** One native registry, created without host mounts, fixed ports or ambient credentials. */
export class OciFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}/`;
  }
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
  /** Independent raw REST upload producer; no candidate push implementation is involved. */
  async #blob(bytes: Uint8Array): Promise<{ digest: string; size: number }> {
    const identifier = await digest(bytes);
    const start = await fetch(new URL(`v2/${OCI_REPOSITORY}/blobs/uploads/`, this.endpoint), {
      method: "POST",
      redirect: "manual",
    });
    try {
      if (start.status !== 202) throw new Error(`Registry fixture upload start: HTTP ${start.status}.`);
      const location = start.headers.get("location");
      if (location === null) throw new Error("Registry fixture did not return upload authority.");
      const url = new URL(location, this.endpoint);
      if (url.origin !== new URL(this.endpoint).origin) {
        throw new Error("Registry fixture upload authority escaped its container origin.");
      }
      url.searchParams.set("digest", identifier);
      const response = await fetch(url, {
        method: "PUT",
        redirect: "manual",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      });
      try {
        if (response.status !== 201) throw new Error(`Registry fixture upload completion: HTTP ${response.status}.`);
      } finally {
        await response.body?.cancel();
      }
    } finally {
      await start.body?.cancel();
    }
    return { digest: identifier, size: bytes.byteLength };
  }
  /** A valid OCI artifact manifest references real uploaded blobs. Native registry calculates its receipt digest. */
  async seed(): Promise<{ blob: string; manifest: string; bytes: Uint8Array }> {
    const config = await this.#blob(new TextEncoder().encode("{}"));
    const blob = await this.#blob(OCI_BLOB);
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType,
        artifactType: "application/vnd.opfs.fixture.v1",
        config: { mediaType: "application/vnd.oci.empty.v1+json", ...config },
        layers: [{ mediaType: "application/octet-stream", ...blob }],
      }),
    );
    const identifier = await digest(bytes);
    for (const tag of ["a", "b", "c"]) {
      const response = await fetch(new URL(`v2/${OCI_REPOSITORY}/manifests/${tag}`, this.endpoint), {
        method: "PUT",
        redirect: "manual",
        headers: { "Content-Type": mediaType },
        body: bytes,
      });
      try {
        if (response.status !== 201) throw new Error(`Registry fixture manifest publication: HTTP ${response.status}.`);
        if (response.headers.get("docker-content-digest") !== identifier) {
          throw new Error("Independent registry receipt digest mismatch.");
        }
      } finally {
        await response.body?.cancel();
      }
    }
    return { blob: blob.digest, manifest: identifier, bytes };
  }
}

/** Testcontainers owns startup/partial acquisition. The fixture owns the successfully started registry. */
export async function openOci(): Promise<OciFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer(OCI_IMAGE)
    .withExposedPorts(PORT)
    .withEnvironment({ REGISTRY_HTTP_ADDR: "0.0.0.0:5000", OTEL_TRACES_EXPORTER: "none" })
    .withDroppedCapabilities("ALL")
    .withSecurityOpt("no-new-privileges")
    .withResourcesQuota({ memory: 0.5, cpu: 1 })
    .withWaitStrategy(Wait.forHttp("/v2/", PORT).forStatusCode(200))
    .withStartupTimeout(90000)
    .start();
  return new OciFixture(container);
}
