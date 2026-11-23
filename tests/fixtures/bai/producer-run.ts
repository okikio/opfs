/** Own configure, make and indexed native consumers as one bounded process group. */
import { fileURLToPath } from "node:url";
import { produce } from "../arrow/runner.ts";
await produce(fileURLToPath(new URL("create.ts", import.meta.url)));
