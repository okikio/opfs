/** Launch only a pre-created, quota-limited offline JWE fixture container. */
import { parseArgs } from "node:util";
import { check } from "../acquire.ts";
import { launch } from "../launch.ts";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: "string" } } });
check(positionals.length === 1 && values.output, "Usage: producer-run.ts opfs-jwe-NAME --output FRESH_PATH");
await launch({ container: positionals[0]!, family: "jwe", stage: "producer", output: values.output });
