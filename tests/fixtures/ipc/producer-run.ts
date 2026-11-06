/** Owns the bounded producer process group and retains its terminal/cleanup receipt. */
import { fileURLToPath } from "node:url";
import { produce } from "../arrow/runner.ts";
await produce(fileURLToPath(new URL("create.ts", import.meta.url)));
