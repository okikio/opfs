import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arch } from "node:process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { StartedTestContainer } from "testcontainers";
import type { FetchType } from "../../src/request.ts";
import { close } from "../close.ts";
/** Maintainer's rootless Gitea1.25.5 multiarch image, verified with buildx2026-11-05. */
export const LFS_IMAGE =
  "docker.gitea.com/gitea@sha256:be0b89adf2fc8657df508303d919c3be33e6413605882919f702177d62960c9a";
export const LFS_BYTES = "independent Git LFS CLI producer bytes\n";
const PORT = 3000,
  origin = "http://127.0.0.1:3000",
  authorization = "Basic " + Buffer.from("fixture:fixture-password-1234").toString("base64");
/** Only fixture-local credentials and repository paths are installed; no host Git configuration enters this container. */
export class LfsFixture implements AsyncDisposable {
  readonly endpoint = `${origin}/fixture/repository.git/info/lfs/`;
  readonly origin = origin;
  readonly authorization = authorization;
  readonly #container: StartedTestContainer;
  readonly #actual: URL;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.#actual = new URL(`http://${container.getHost()}:${container.getMappedPort(PORT)}/`);
  }
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /** Address translation is fixture-only: signed actions retain the server's logical origin and path. */
  readonly fetch: FetchType = (input, init) => {
    const logical = new URL(input.toString());
    if (logical.origin !== origin) throw new Error("Fixture refuses a foreign Git LFS target.");
    const target = new URL(this.#actual);
    target.pathname = logical.pathname;
    target.search = logical.search;
    return fetch(target, init);
  };
  async #exec(args: string[]): Promise<string> {
    const result = await this.#container.exec(args);
    if (result.exitCode !== 0) throw new Error(`Native Git LFS fixture failed: ${result.output}`);
    return result.stdout;
  }
  /** Native Git LFS clean/pre-push uploads the object to the actual Gitea server. */
  async seed(): Promise<{ oid: string; size: number }> {
    await this.#exec([
      "sh",
      "-c",
      `set -eu
git clone http://fixture:fixture-password-1234@127.0.0.1:3000/fixture/repository.git /tmp/oracle
cd /tmp/oracle
git config user.name Fixture
git config user.email fixture@example.invalid
git lfs install --local
git lfs track '*.bin'
printf '%s' "$1" > producer.bin
git add .gitattributes producer.bin
git commit -m fixture
git push origin HEAD
`,
      "--",
      LFS_BYTES,
    ]);
    const pointer = await this.#exec(["git", "-C", "/tmp/oracle", "show", "HEAD:producer.bin"]);
    const oid = /^oid sha256:([a-f0-9]{64})$/m.exec(pointer)?.[1], size = Number(/^size (\d+)$/m.exec(pointer)?.[1]);
    if (oid === undefined || !Number.isSafeInteger(size)) throw new Error("Native producer pointer differs.");
    return { oid, size };
  }
  /** Official Git LFS smudge fetches a candidate-uploaded object, outside its own existing object cache. */
  async read(oid: string, size: number): Promise<Uint8Array> {
    const output = await this.#exec([
      "sh",
      "-c",
      `set -eu
cd /tmp/oracle
printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize %s\\n' "$1" "$2" >/tmp/candidate.pointer
git lfs smudge </tmp/candidate.pointer >/tmp/candidate.bytes
base64 /tmp/candidate.bytes
`,
      "--",
      oid,
      String(size),
    ]);
    return new Uint8Array(Buffer.from(output.replaceAll(/\s/g, ""), "base64"));
  }
}
/** Testcontainers owns native server and CLI; primary release bytes are hash-checked before building the fixture. */
export async function openLfsFixture(): Promise<LfsFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const hashes: Record<string, string> = {
    arm64: "67895dd77b63329796bc5efdd47b57f218e1f7b98717ebaf936a8238dbcaec0f",
    x64: "e72cf723a4a660438862282e8aecf3885fc8123e88bfcad534cf6b941a354b75",
  };
  const expected = hashes[arch];
  if (expected === undefined) throw new Error("Git LFS fixture supports Linux amd64/arm64 images only.");
  const response = await fetch(
    `https://github.com/git-lfs/git-lfs/releases/download/v3.8.1/git-lfs-linux-${
      arch === "x64" ? "amd64" : "arm64"
    }-v3.8.1.tar.gz`,
  );
  if (!response.ok) throw new Error("Official Git LFS fixture download failed.");
  const binary = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(binary).digest("hex") !== expected) {
    throw new Error("Official Git LFS fixture artifact hash differs.");
  }
  const directory = await mkdtemp(join(tmpdir(), "opfs-lfs-"));
  let container: StartedTestContainer | undefined;
  try {
    await Promise.all([
      writeFile(join(directory, "lfs.tgz"), binary),
      writeFile(
        join(directory, "Dockerfile"),
        `FROM ${LFS_IMAGE}\nUSER root\nCOPY lfs.tgz /tmp/lfs.tgz\nRUN tar -xzf /tmp/lfs.tgz -C /tmp && cp /tmp/git-lfs-3.8.1/git-lfs /usr/local/bin/git-lfs && chmod 755 /usr/local/bin/git-lfs && rm -rf /tmp/lfs.tgz /tmp/git-lfs-3.8.1\nUSER git\n`,
      ),
    ]);
    const built = await GenericContainer.fromDockerfile(directory).build();
    await rm(directory, { recursive: true, force: true });
    container = await built.withEnvironment({
      GITEA__security__INSTALL_LOCK: "true",
      GITEA__server__ROOT_URL: origin + "/",
      GITEA__server__LFS_START_SERVER: "true",
      GITEA__database__DB_TYPE: "sqlite3",
      GITEA__service__DISABLE_REGISTRATION: "true",
      GITEA__server__DISABLE_SSH: "true",
    })
      .withExposedPorts(PORT).withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges").withResourcesQuota({
        memory: 0.5,
        cpu: 1,
      }).withWaitStrategy(Wait.forHttp("/api/healthz", PORT).forStatusCode(200)).withStartupTimeout(90_000).start();
    const created = await container.exec([
      "gitea",
      "admin",
      "user",
      "create",
      "--username",
      "fixture",
      "--password",
      "fixture-password-1234",
      "--email",
      "fixture@example.invalid",
      "--admin",
      "--must-change-password=false",
      "--config",
      "/etc/gitea/app.ini",
    ]);
    if (created.exitCode !== 0) throw new Error(`Gitea fixture account creation failed: ${created.output}`);
    const fixture = new LfsFixture(container);
    const repository = await fixture.fetch(new URL("/api/v1/user/repos", origin), {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "repository", private: false, auto_init: true, default_branch: "main" }),
    });
    try {
      if (repository.status !== 201) {
        throw new Error(`Gitea fixture repository creation failed: HTTP ${repository.status}.`);
      }
    } finally {
      await repository.body?.cancel();
    }
    return fixture;
  } catch (reason) {
    await close([
      ...(container === undefined ? [] : [() => container!.stop()]),
      () => rm(directory, { recursive: true, force: true }),
    ], [reason]);
    throw reason;
  }
}
