import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { env, execPath } from "node:process";

import { openProviders } from "../tests/provider/fixture.ts";
import { finish } from "./result.ts";
import { runProgram } from "./process.ts";

/** Environment names consumed by the provider benchmark programs. */
interface ProviderEnvType extends NodeJS.ProcessEnv {
  /** Testcontainers-selected host endpoint for the S3-compatible service. */
  OPFS_S3_ENDPOINT: string;
  /** Testcontainers-selected host endpoint for the Azurite Blob service. */
  OPFS_AZURE_ENDPOINT: string;
}

/** Runs one benchmark program with inherited stdio and fails on a non-zero exit. */
async function run(
  command: string,
  args: readonly string[],
  providerEnv: ProviderEnvType,
  report?: string,
): Promise<void> {
  const file = report === undefined ? undefined : await open(report, "wx");
  let failed = false;
  let primary: unknown;
  try {
    await runProgram(command, args, {
      env: providerEnv,
      stdio: file === undefined ? "inherit" : ["inherit", file.fd, "inherit"],
    });
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await finish([async () => {
      await file?.close();
    }], failed ? [primary] : []);
  }
}

/** Creates the child-process environment after provider endpoints are known. */
function getProviderEnv(s3Endpoint: string, azureEndpoint: string): ProviderEnvType {
  return {
    ...env,
    OPFS_S3_ENDPOINT: s3Endpoint,
    OPFS_AZURE_ENDPOINT: azureEndpoint,
  } as ProviderEnvType;
}

/** Provider services live outside timed benchmark programs and close after both programs finish. */
await using providers = await openProviders();
/** Child-process environment carrying the Testcontainers-selected endpoints. */
const providerEnv = getProviderEnv(providers.s3Endpoint, providers.azureEndpoint);
/** Optional report ownership keeps each runtime's native JSON in a separate immutable file. */
const reportRoot = env.OPFS_BENCH_REPORT_DIR;
if (reportRoot !== undefined) await mkdir(reportRoot, { recursive: true });

await run(
  execPath,
  ["--expose-gc", "bench/provider.bench.ts"],
  providerEnv,
  reportRoot === undefined ? undefined : join(reportRoot, "provider-node.json"),
);
await run(
  "bun",
  ["run", "bench/bun-provider.bench.ts"],
  providerEnv,
  reportRoot === undefined ? undefined : join(reportRoot, "provider-bun.json"),
);
