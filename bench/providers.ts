import { spawn } from "node:child_process";
import { env, execPath } from "node:process";

import { openProviders } from "../tests/provider/fixture.ts";

/** Environment names consumed by the provider benchmark programs. */
interface ProviderEnvType extends NodeJS.ProcessEnv {
  /** Testcontainers-selected host endpoint for the S3-compatible service. */
  OPFS_S3_ENDPOINT: string;
  /** Testcontainers-selected host endpoint for the Azurite Blob service. */
  OPFS_AZURE_ENDPOINT: string;
}

/** Runs one benchmark program with inherited stdio and fails on a non-zero exit. */
async function run(command: string, args: readonly string[], providerEnv: ProviderEnvType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: providerEnv,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown status"}.`));
    });
  });
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

await run(execPath, ["bench/provider.bench.ts"], providerEnv);
await run("bun", ["run", "bench/bun-provider.bench.ts"], providerEnv);
