/** Explicit extract-only test SDK notice producer. Run from the repository root after reviewing its pinned acquisition recipe; no SDK module is imported. */
import { readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { close } from "../../close.ts";
import { PUBSUB_ORACLE_IMAGE } from "../../provider/pubsub.ts";
import { GenericContainer, getContainerRuntimeClient, Network, Wait } from "testcontainers";
const packageBytes = await readFile("tests/fixtures/pubsub/sdk-package.json");
const lockBytes = await readFile("tests/fixtures/pubsub/sdk-lock.json");
if (
  createHash("sha256").update(lockBytes).digest("hex") !==
    "be831ae4d6d51f6db1cc66b0fc11db9da39f8ce07c4accf243f296d2946cfd45"
) throw new Error("Notice lock differs.");
const source = await readFile("tests/fixtures/pubsub/notices.cjs");
const runtime = await getContainerRuntimeClient(), resources: (() => Promise<unknown>)[] = [], ids: string[] = [];
let primary: readonly unknown[] = [];
class OwnedContainer extends GenericContainer {
  constructor() {
    super(PUBSUB_ORACLE_IMAGE);
    this.hostConfig.PidsLimit = 128;
    this.hostConfig.MemorySwap = 536870912;
  }
  protected override containerCreated(id: string): Promise<void> {
    ids.push(id);
    resources.push(async () => {
      try {
        await runtime.container.getById(id).remove({ force: true, v: true });
      } catch (reason) {
        if (reason === null || typeof reason !== "object" || !("statusCode" in reason) || reason.statusCode !== 404) {
          throw reason;
        }
      }
    });
    return Promise.resolve();
  }
}
try {
  const network = await new Network().start();
  resources.push(() => network.stop());
  const container = await new OwnedContainer().withNetwork(network).withWorkingDir("/oracle")
    .withEnvironment({ GCE_METADATA_DISABLED: "true", GOOGLE_CLOUD_PROJECT: "opfs-pubsub" })
    .withCopyContentToContainer([{ content: packageBytes, target: "/oracle/package.json" }, {
      content: lockBytes,
      target: "/oracle/package-lock.json",
    }, { content: source, target: "/oracle/notices.cjs" }])
    .withCommand([
      "sh",
      "-c",
      "timeout 120 npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache && node /oracle/notices.cjs && touch /oracle/ready && exec sleep 600",
    ])
    .withResourcesQuota({ memory: 0.5, cpu: 0.5 }).withWaitStrategy(Wait.forSuccessfulCommand("test -f /oracle/ready"))
    .withStartupTimeout(150000).start();
  resources.push(() => container.stop());
  const raw = execFileSync("docker", ["inspect", container.getId()], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 65536,
  });
  await writeFile(".tmp/pubsub-notices-container.json", raw);
  const actual = JSON.parse(raw)[0], host = actual.HostConfig;
  if (
    host.Memory !== 536870912 || host.MemorySwap !== 536870912 || host.NanoCpus !== 500000000 ||
    host.PidsLimit !== 128 || actual.Mounts.length !== 0
  ) throw new Error("Notice acquisition actual quota differs.");
  execFileSync("docker", ["cp", container.getId() + ":/oracle/sdk-notices.json", ".tmp/pubsub-sdk-notices.json"], {
    timeout: 10000,
    maxBuffer: 65536,
  });
  console.log(
    JSON.stringify({
      id: container.getId(),
      image: actual.Image,
      memory: host.Memory,
      swap: host.MemorySwap,
      nanoCpus: host.NanoCpus,
      pids: host.PidsLimit,
      mounts: actual.Mounts,
    }),
  );
  const size = (await stat(".tmp/pubsub-sdk-notices.json")).size;
  if (size > 12582912) throw new Error("Copied notice bytes exceed policy.");
  const bytes = await readFile(".tmp/pubsub-sdk-notices.json");
  console.log(JSON.stringify({ noticeBytes: size, sha256: createHash("sha256").update(bytes).digest("hex") }));
} catch (reason) {
  primary = [reason];
  for (const id of ids) {
    try {
      console.error(
        "Notice acquisition diagnostics:",
        execFileSync("docker", ["logs", id], { encoding: "utf8", timeout: 10000, maxBuffer: 1048576 }),
      );
    } catch (error) {
      console.error("Notice diagnostics unavailable:", error);
    }
  }
} finally {
  await close(resources.reverse(), primary);
}
