import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Official multiarch image indexes verified using buildx on 2026-11-05. */
export const FIREBASE_NODE_IMAGE = "node@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
export const FIREBASE_JRE_IMAGE =
  "eclipse-temurin@sha256:0eda5830ed7b669abc246a8dc520ea8a23cab06f9a8d4b6964109e2f2394e46f";
export const FIREBASE_BUCKET = "demo-opfs.appspot.com";
export const FIREBASE_BYTES = "independent Firebase SDK producer bytes";
/** Unsigned emulator-only token; never valid Firebase production authentication. */
export const FIREBASE_TEST_TOKEN = [
  { alg: "none", typ: "JWT" },
  {
    sub: "fixture",
    user_id: "fixture",
    aud: "demo-opfs",
    iss: "https://securetoken.google.com/demo-opfs",
    iat: 0,
    exp: 4102444800,
  },
].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".";
const PORT = 9199;
const rules =
  `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /allowed/{allPaths=**} { allow read, write: if true; } match /authenticated/{allPaths=**} { allow read, write: if request.auth.uid == 'fixture'; } match /denied/{allPaths=**} { allow read, write: if false; } } }`;
const config = JSON.stringify({
  storage: { rules: "storage.rules" },
  emulators: { storage: { host: "0.0.0.0", port: PORT }, ui: { enabled: false }, singleProjectMode: true },
});
const dockerfile = `FROM ${FIREBASE_NODE_IMAGE} AS node
FROM ${FIREBASE_JRE_IMAGE}
COPY --from=node /usr/local/ /usr/local/
WORKDIR /fixture
COPY download.ts sdk.ts storage.rules firebase.json ./
RUN node download.ts && npm install --ignore-scripts --no-audit --no-fund ./tools.tgz ./sdk.tgz && rm tools.tgz sdk.tgz
ENV CI=true FIREBASE_CLI_DISABLE_UPDATE_CHECK=true FIREBASE_CLI_EXPERIMENTS=""
CMD ["node","node_modules/firebase-tools/lib/bin/firebase.js","emulators:start","--only","storage","--project","demo-opfs","--config","/fixture/firebase.json"]
`;
/** Testcontainers owns one real Firebase emulator and its independent SDK producer/reader. */
export class FirebaseFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}/v0/`;
  }
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /** Official SDK over the loopback emulator. No candidate client code creates or reads the oracle bytes. */
  async sdk(action: "seed" | "read" | "metadata" | "list", name: string, value = ""): Promise<string> {
    const result = await this.#container.exec(["node", "/fixture/sdk.ts", action, name, value]);
    if (result.exitCode !== 0) throw new Error(`Independent Firebase SDK failed: ${result.output}`);
    return result.stdout.trim();
  }
}
/** Reproducible primary artifact pins; npm resolves test-tool transitive dependencies during build, not production. */
export async function openFirebaseFixture(): Promise<FirebaseFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const directory = await mkdtemp(join(tmpdir(), "opfs-firebase-"));
  let container: StartedTestContainer | undefined;
  try {
    await Promise.all([
      writeFile(join(directory, "Dockerfile"), dockerfile),
      writeFile(
        join(directory, "download.ts"),
        await readFile(fileURLToPath(new URL("../fixtures/firebase/download.ts", import.meta.url).href)),
      ),
      writeFile(
        join(directory, "sdk.ts"),
        await readFile(fileURLToPath(new URL("../fixtures/firebase/sdk.ts", import.meta.url).href)),
      ),
      writeFile(join(directory, "storage.rules"), rules),
      writeFile(join(directory, "firebase.json"), config),
    ]);
    const built = await GenericContainer.fromDockerfile(directory).build();
    await rm(directory, { recursive: true, force: true });
    container = await built.withExposedPorts(PORT).withWaitStrategy(Wait.forLogMessage("All emulators ready!"))
      .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withResourcesQuota({ memory: 0.75, cpu: 1 }).withStartupTimeout(120_000).start();
    return new FirebaseFixture(container);
  } catch (reason) {
    await close([
      ...(container === undefined ? [] : [() => container!.stop()]),
      () => rm(directory, { recursive: true, force: true }),
    ], [reason]);
    throw reason;
  }
}
