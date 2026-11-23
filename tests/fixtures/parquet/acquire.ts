/** Explicit network stage; no archive code is executed. */
import { parseArgs } from "node:util";
import { acquire } from "../arrow/admit.ts";
const { values } = parseArgs({ options: { output: { type: "string" }, orc: { type: "boolean", default: false } } });
if (values.output === undefined) throw new TypeError("A new --output directory is required.");
await acquire(values.output, !values.orc);
