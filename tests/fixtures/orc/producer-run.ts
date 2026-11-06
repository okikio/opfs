/** Preserves group deadline and combined diagnostic ownership outside the producer. */
import { fileURLToPath } from "node:url";
import { produce } from "../arrow/runner.ts";
await produce(fileURLToPath(new URL("create.ts", import.meta.url)));
