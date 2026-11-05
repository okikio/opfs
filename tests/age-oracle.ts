/** Typed test-only injection of the shared Deno native cipher transport. */
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { createDenoAgeOracle as createOracle } from "./fixtures/age/provider.mjs";
import { AgeError } from "../src/crypto/age.ts";
import type { AgeAeadType } from "../src/crypto/age.ts";

export interface AgeTestCipherType extends AgeAeadType {
  encrypt(
    key: Uint8Array<ArrayBuffer>,
    nonce: Uint8Array<ArrayBuffer>,
    plain: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array>;
}
/** The caller selects the binary; construction never starts a child. */
export function createDenoAgeOracle(executable: string): AgeTestCipherType {
  return createOracle(executable, fileURLToPath(new URL("./fixtures/age/oracle.mjs", import.meta.url)), AgeError, {
    PATH: env.PATH ?? "",
    ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
  });
}
