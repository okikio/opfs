/** Admit the native child locale before the first browser is acquired. @module */
import { fileURLToPath } from "node:url";
import { admit } from "./environment.ts";

export default async function setup(): Promise<void> {
  await admit(fileURLToPath(new URL("../../", import.meta.url)), "browser");
}
