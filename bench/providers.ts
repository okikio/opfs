import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env, execPath } from "node:process";

import { openProviders } from "../tests/provider/fixture.ts";
import { finish } from "./result.ts";
import { runProgram } from "./process.ts";
import { openInputGuard } from "./input.ts";

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

/** Standalone and parent-collected provider runs admit the same maintained inputs. */
const reportRoot = env.OPFS_PROVIDER_VERIFY === "1" ? undefined : env.OPFS_BENCH_REPORT_DIR;
const parent = join(".tmp", "reports", env.OPFS_PROVIDER_VERIFY === "1" ? "provider-verify" : "provider-bench");
await mkdir(reportRoot ?? parent, { recursive: true });
const evidence = reportRoot ?? await mkdtemp(join(parent, `${new Date().toISOString().replaceAll(":", "-")}-`));
const completeInputs = await openInputGuard(async (receipt) => {
  await writeFile(join(evidence, "provider-inputs.json"), JSON.stringify(receipt, null, 2) + "\n");
});
let failed = false;
let primary: unknown;
try {
  /** Provider services live outside timed benchmark programs and close after both programs finish. */
  await using providers = await openProviders();
  /** Child-process environment carrying the Testcontainers-selected endpoints. */
  const providerEnv = getProviderEnv(providers.s3Endpoint, providers.azureEndpoint);

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
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish([completeInputs], failed ? [primary] : []);
}
