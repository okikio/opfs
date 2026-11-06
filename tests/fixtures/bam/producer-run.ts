/** Group ownership covers configure, make and all descendant native consumers. */
import { fileURLToPath } from "node:url";
import { produce } from "../arrow/runner.ts";
await produce(fileURLToPath(new URL("create.ts", import.meta.url)));
