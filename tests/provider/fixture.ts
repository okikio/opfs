import type { StartedAzuriteContainer } from "@testcontainers/azurite";
import type { StartedTestContainer } from "testcontainers";

/** SeaweedFS image used for the S3-compatible provider fixture. */
export const S3_IMAGE = "chrislusf/seaweedfs:4.41";
/** SeaweedFS4.41 form-escapes EncodingType=url listing keys; every project client uses this explicit wire dialect. */
export const S3_LIST_ENCODING = "form" as const;
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

/** Only the SDK resource retirement capability used by this fixture. */
export interface ProviderResourceType {
  /** Stops an acquired container; its SDK result is not fixture authority. */
  stop(): Promise<unknown>;
}

/** S3 container observations used to build the Testcontainers-selected endpoint. */
export interface S3ProviderType extends ProviderResourceType {
  /** Host selected by Testcontainers, which can be a gateway inside a Docker runner. */
  getHost(): string;
  /** Host port selected by Testcontainers for one exposed service port. */
  getMappedPort(port: number): number;
}

/** Azure container observation used after the resource owner has been recorded. */
export interface AzureProviderType extends ProviderResourceType {
  /** HTTP Blob endpoint including its development account pathname. */
  getBlobEndpoint(): string;
}

/** Attempts all acquired retirements, preserving the original failure independently. */
async function stop(containers: readonly ProviderResourceType[], primary: readonly unknown[] = []): Promise<void> {
  const failures = [...primary];
  for (const container of containers) {
    try {
      await container.stop();
    } catch (reason) {
      failures.push(reason);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Provider fixture retirement failed.", { cause: failures[0] });
  }
}

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
  readonly #containers: readonly ProviderResourceType[];
  /** Every close observes the same pending or failed terminal retirement. */
  #closure: Promise<void> | undefined;

  /** Creates an owned fixture from already-started provider containers. */
  constructor(
    s3: S3ProviderType,
    azure: ProviderResourceType,
    azureEndpoint: string,
  ) {
    this.s3Endpoint = `http://${s3.getHost()}:${s3.getMappedPort(S3_PORT)}`;
    this.azureEndpoint = azureEndpoint;
    this.#containers = [azure, s3];
  }

  /** Stops both acquired resources once; concurrent closes share completion and failure. */
  close(): Promise<void> {
    // Assign before invoking SDK stop, including a synchronously reentrant caller.
    return this.#closure ??= Promise.resolve().then(() => stop(this.#containers));
  }

  /** Releases the provider containers when used with `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Starts the SeaweedFS S3-compatible fixture and waits for its HTTP surface. */
async function openS3(): Promise<StartedTestContainer> {
  // SDK import inspects its host environment. Only actual acquisition owns that effect.
  const { GenericContainer, Wait } = await import("testcontainers");
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

/** Starts the official Azurite module; the caller records ownership before reading its endpoint. */
async function openAzure(): Promise<StartedAzuriteContainer> {
  const { AzuriteContainer } = await import("@testcontainers/azurite");
  return await new AzuriteContainer(AZURE_IMAGE)
    .withSkipApiVersionCheck()
    .withInMemoryPersistence()
    .withAccountName(AZURE_ACCOUNT)
    .withAccountKey(AZURE_KEY)
    .withStartupTimeout(90_000)
    .start();
}

/**
 * Starts all provider fixtures and cleans up partial construction on failure.
 *
 * Startup is deliberately sequential. A provider failure therefore has one
 * unambiguous owner to stop, and diagnostics remain easier to attribute than a
 * partially successful parallel startup race. SDK value imports occur only in
 * these actual acquisitions: reading fixture constants or injecting controlled
 * resources does not inspect the host or discover Docker configuration.
 */
export async function openProviders(
  acquire: {
    /** Benchmark-fixture acquisition seam; normal callers use the actual S3 Testcontainers factory. */
    readonly s3?: () => Promise<S3ProviderType>;
    /** Benchmark-fixture acquisition seam; normal callers use the actual Azurite factory. */
    readonly azure?: () => Promise<AzureProviderType>;
  } = {},
): Promise<ProviderFixture> {
  const s3 = await (acquire.s3 ?? openS3)();
  let azure: AzureProviderType | undefined;
  try {
    azure = await (acquire.azure ?? openAzure)();
    return new ProviderFixture(s3, azure, azure.getBlobEndpoint());
  } catch (error) {
    // Endpoint reads and construction can fail after Azure acquisition. Both
    // recorded resources must retire even when either stop independently fails.
    await stop(azure === undefined ? [s3] : [azure, s3], [error]);
    throw error;
  }
}
