import type { StartedTestContainer } from "testcontainers";
/** Maintainer-provided WsgiDAV image, immutable digest inspected on 2026-11-05. */
export const WEBDAV_IMAGE =
  "docker.io/mar10/wsgidav@sha256:53573e6705ed6fda1451713b160ca08b28238b19d016056f4bc4d67c954c59c7";
const PORT = 8080;
/** One isolated anonymous development share; no host data or ambient credentials are mounted. */
export class WebdavFixture implements AsyncDisposable {
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
}
/** Startup acquisition and partial-start cleanup are owned by Testcontainers; the fixture owns a successful service. */
export async function openWebdav(): Promise<WebdavFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer(WEBDAV_IMAGE)
    .withExposedPorts(PORT)
    .withResourcesQuota({ memory: 0.5, cpu: 1 })
    .withDroppedCapabilities("ALL")
    .withSecurityOpt("no-new-privileges")
    .withWaitStrategy(Wait.forHttp("/", PORT).forStatusCode(200))
    .withStartupTimeout(90_000)
    .start();
  return new WebdavFixture(container);
}
