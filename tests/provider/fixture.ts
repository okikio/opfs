import { AzuriteContainer, type StartedAzuriteContainer } from "@testcontainers/azurite";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

/** SeaweedFS image used for the S3-compatible provider fixture. */
export const S3_IMAGE = "chrislusf/seaweedfs:4.41";
/** Azurite image used for the Azure Blob provider fixture. */
export const AZURE_IMAGE = "mcr.microsoft.com/azure-storage/azurite:3.36.0";
/** Bucket and container name shared by provider integration tests and benchmarks. */
export const STORAGE_NAME = "opfs-test";
/** Access key exposed by the SeaweedFS test fixture. */
export const S3_ACCESS_KEY = "admin";
/** Secret key exposed by the SeaweedFS test fixture. */
export const S3_SECRET_KEY = "secret";
/** Account name exposed by the Azurite test fixture. */
export const AZURE_ACCOUNT = "devstoreaccount1";
/** Development-only Shared Key used by the isolated Azurite fixture. */
export const AZURE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
/** S3 API port inside the SeaweedFS container. */
const S3_PORT = 8333;

/**
 * Owns one S3-compatible service and one Azure Blob emulator for a test run.
 *
 * Testcontainers chooses free host ports, waits for the services, and removes
 * the containers. Callers receive only provider endpoints and credentials, so
 * tests do not depend on Docker Compose names or fixed host ports.
 */
export class ProviderFixture implements AsyncDisposable {
  /** Host endpoint for the S3-compatible API. */
  readonly s3Endpoint: string;
  /** Host endpoint for the Azurite Blob service, including the account path. */
  readonly azureEndpoint: string;
  /** Containers are retained only so this fixture can release what it started. */
  readonly #containers: readonly StartedTestContainer[];
  /** Prevents a second close from asking Testcontainers to stop resources twice. */
  #closed = false;

  /** Creates an owned fixture from already-started provider containers. */
  constructor(
    s3: StartedTestContainer,
    azure: StartedAzuriteContainer,
    azureEndpoint: string,
  ) {
    this.s3Endpoint = `http://${s3.getHost()}:${s3.getMappedPort(S3_PORT)}`;
    this.azureEndpoint = azureEndpoint;
    this.#containers = [azure, s3];
  }

  /** Stops and removes both provider containers in reverse acquisition order. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const failures: unknown[] = [];
    for (const container of this.#containers) {
      try {
        await container.stop();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more provider test containers could not be stopped.");
    }
  }

  /** Releases the provider containers when used with `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Starts the SeaweedFS S3-compatible fixture and waits for its HTTP surface. */
async function openS3(): Promise<StartedTestContainer> {
  return await new GenericContainer(S3_IMAGE)
    .withCommand(["mini", "-dir=/data"])
    .withEnvironment({
      AWS_ACCESS_KEY_ID: S3_ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: S3_SECRET_KEY,
      S3_BUCKET: STORAGE_NAME,
    })
    .withExposedPorts(S3_PORT)
    .withWaitStrategy(
      Wait.forAll([
        Wait.forListeningPorts(),
        Wait.forHttp("/", S3_PORT).forStatusCodeMatching((status) => status >= 200 && status < 500),
      ]),
    )
    .withStartupTimeout(90_000)
    .start();
}

/** Starts the official Azurite Testcontainers module with isolated in-memory state. */
async function openAzure(): Promise<{ container: StartedAzuriteContainer; endpoint: string }> {
  const container = await new AzuriteContainer(AZURE_IMAGE)
    .withSkipApiVersionCheck()
    .withInMemoryPersistence()
    .withAccountName(AZURE_ACCOUNT)
    .withAccountKey(AZURE_KEY)
    .withStartupTimeout(90_000)
    .start();

  return { container, endpoint: container.getBlobEndpoint() };
}

/**
 * Starts all provider fixtures and cleans up partial construction on failure.
 *
 * Startup is deliberately sequential. A provider failure therefore has one
 * unambiguous owner to stop, and diagnostics remain easier to attribute than a
 * partially successful parallel startup race.
 */
export async function openProviders(): Promise<ProviderFixture> {
  const s3 = await openS3();
  try {
    const azure = await openAzure();
    return new ProviderFixture(s3, azure.container, azure.endpoint);
  } catch (error) {
    await s3.stop().catch(() => undefined);
    throw error;
  }
}
