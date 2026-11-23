import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Reviewed official Node26.13 bookworm-slim index; native TypeScript runner support is explicit. */
export const POCKETBASE_IMAGE = "node@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
export const POCKETBASE_BYTES = "independent official PocketBase SDK producer bytes\n";
const PORT = 8090;
const dockerfile = `FROM ${POCKETBASE_IMAGE}
WORKDIR /fixture
RUN apt-get update && apt-get install -y --no-install-recommends --download-only unzip && mkdir -p /fixture/receipts && sha256sum /var/cache/apt/archives/*.deb > /fixture/receipts/debs.sha256 && apt-get install -y --no-install-recommends unzip && dpkg-query -W > /fixture/receipts/packages.txt && cp /var/lib/apt/lists/*InRelease /fixture/receipts/ && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
COPY download.ts sdk.ts ./
RUN node download.ts && unzip server.zip pocketbase && tar -xzf sdk.tgz && rm server.zip sdk.tgz && chmod 755 pocketbase && chown -R node:node /fixture
USER node
CMD ["sh","-c","./pocketbase superuser upsert fixture@example.invalid fixture-password-1234 --dir=/fixture/data && exec ./pocketbase serve --http=0.0.0.0:8090 --dir=/fixture/data"]
`;
/** The caller owns fixture disposal. No host account, Git configuration or globally installed tool enters the server. */
export class PocketbaseFixture implements AsyncDisposable {
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
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  async sdk(action: "setup" | "read" | "get", ...args: string[]): Promise<readonly unknown[]> {
    const result = await this.#container.exec(["node", "/fixture/sdk.ts", action, ...args]);
    if (result.exitCode !== 0) throw new Error(`Independent PocketBase SDK failed: ${result.output}`);
    return result.stdout.trim().split("\n").map((line) => JSON.parse(line) as unknown);
  }
}
/** Testcontainers owns genuine server startup, ephemeral port readiness and complete cleanup after partial failure. */
export async function openPocketbaseFixture(): Promise<PocketbaseFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const directory = await mkdtemp(join(tmpdir(), "opfs-pocketbase-"));
  let container: StartedTestContainer | undefined;
  try {
    await Promise.all([
      writeFile(join(directory, "Dockerfile"), dockerfile),
      writeFile(
        join(directory, "download.ts"),
        await readFile(fileURLToPath(new URL("../fixtures/pocketbase/download.ts", import.meta.url).href)),
      ),
      writeFile(
        join(directory, "sdk.ts"),
        await readFile(fileURLToPath(new URL("../fixtures/pocketbase/sdk.ts", import.meta.url).href)),
      ),
    ]);
    const built = await GenericContainer.fromDockerfile(directory).build();
    await rm(directory, { recursive: true, force: true });
    container = await built.withExposedPorts(PORT).withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withResourcesQuota({ memory: 0.5, cpu: 1 }).withWaitStrategy(
        Wait.forHttp("/api/health", PORT).forStatusCode(200),
      ).withStartupTimeout(90_000).start();
    return new PocketbaseFixture(container);
  } catch (reason) {
    await close([
      ...(container === undefined ? [] : [() => container!.stop()]),
      () => rm(directory, { recursive: true, force: true }),
    ], [reason]);
    throw reason;
  }
}
