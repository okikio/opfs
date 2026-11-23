/** Offline extraction replaces historical pip installation. */
import { parseArgs } from "node:util";
import { install } from "../arrow/admit.ts";
const { values } = parseArgs({ options: { receipts: { type: "string" }, output: { type: "string" } } });
if (values.receipts === undefined || values.output === undefined) {
  throw new TypeError("--receipts and a new --output directory are required.");
}
install(values.receipts, values.output, true);
