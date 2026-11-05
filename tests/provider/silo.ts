import type { StartedTestContainer } from "testcontainers";

/** Same immutable multi-architecture Silo image qualified by Core's disposable-store fixture.
 * Silo is PGSTY's S3-compatible server, not a Google Cloud emulator. Its AGPL
 * server runs only in tests and is never imported or distributed by OPFS.
 */
export const SILO_IMAGE =
  "docker.io/pgsty/silo:RELEASE.2026-10-18T00-00-00Z@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7";

/** Explicit disposable service. Consumers borrow configuration until close completes. */
export interface SiloFixtureType extends AsyncDisposable {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

/** Starts a pinned test-only service; no Docker, credentials or networking occurs on import. */
export async function openSilo(): Promise<SiloFixtureType> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const { CreateBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const credentials = { accessKeyId: "opfs-fixture", secretAccessKey: crypto.randomUUID() };
  const region = "us-east-1";
  const bucket = "opfs-fixture";
  const container: StartedTestContainer = await new GenericContainer(SILO_IMAGE)
    .withCommand(["server", "/data"])
    .withUser("1000:1000")
    .withEnvironment({
      MINIO_ROOT_USER: credentials.accessKeyId,
      MINIO_ROOT_PASSWORD: credentials.secretAccessKey,
      MINIO_SITE_REGION: region,
      MINIO_BROWSER: "off",
    })
    .withExposedPorts(9000)
    .withTmpFs({ "/data": "rw,size=256m,uid=1000,gid=1000,mode=0700" })
    .withResourcesQuota({ memory: 0.5, cpu: 1 })
    .withDroppedCapabilities("ALL")
    .withSecurityOpt("no-new-privileges")
    .withStartupTimeout(90_000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .start();
  let closing: Promise<void> | undefined;
  const close = () =>
    closing ??= Promise.resolve().then(async () => {
      await container.stop();
    });
  try {
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    const client = new S3Client({ endpoint, region, credentials, forcePathStyle: true, maxAttempts: 5 });
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(30_000) });
    } finally {
      client.destroy();
    }
    return { endpoint, region, bucket, credentials, [Symbol.asyncDispose]: close };
  } catch (reason) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([reason, cleanup], "Silo fixture acquisition and cleanup failed.", { cause: reason });
    }
    throw reason;
  }
}
