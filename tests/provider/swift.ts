import type { StartedTestContainer } from "testcontainers";

/** Community-maintained SAIO linux/amd64 image inspected and pinned on 2026-11-05. */
export const SWIFT_IMAGE =
  "docker.io/openstackswift/saio@sha256:86d661810cf1d19f23af2b43f69be4cfd69bb13630755c1d8a4056f49f0785e3";
export const SWIFT_CONTAINER = "opfs-test";
const PORT = 8080;

/** One disposable local cluster and fixture-only authorization. Callers borrow its configured account. */
export class SwiftFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly token: string;
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer, endpoint: string, token: string) {
    this.#container = container;
    this.endpoint = endpoint;
    this.token = token;
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

/** No ambient OpenStack credentials: obtain the image's documented test:tester account after readiness. */
export async function openSwift(): Promise<SwiftFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer(SWIFT_IMAGE)
    .withExposedPorts(PORT)
    .withResourcesQuota({ memory: 1, cpu: 1 })
    .withSecurityOpt("no-new-privileges")
    .withWaitStrategy(Wait.forHttp("/healthcheck", PORT).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  try {
    const origin = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
    const auth = await fetch(`${origin}/auth/v1.0`, {
      headers: { "x-auth-user": "test:tester", "x-auth-key": "testing" },
    });
    await auth.arrayBuffer();
    const token = auth.headers.get("x-auth-token");
    const storage = auth.headers.get("x-storage-url");
    if (!auth.ok || !token || !storage) throw new Error(`Swift fixture authentication failed: ${auth.status}.`);
    // SAIO advertises its internal proxy port. The account path is retained;
    // network authority remains the explicitly owned ephemeral container port.
    const endpoint = `${origin}${new URL(storage).pathname}`;
    const created = await fetch(`${endpoint}/${SWIFT_CONTAINER}`, {
      method: "PUT",
      headers: { "x-auth-token": token },
    });
    await created.arrayBuffer();
    if (!created.ok) throw new Error(`Swift fixture container creation failed: ${created.status}.`);
    return new SwiftFixture(container, endpoint, token);
  } catch (reason) {
    try {
      await container.stop();
    } catch (cleanup) {
      throw new AggregateError([reason, cleanup], "Swift initialization and cleanup failed.", { cause: reason });
    }
    throw reason;
  }
}
