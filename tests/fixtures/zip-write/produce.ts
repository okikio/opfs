/** Authored deterministic interoperability workload. No generated ZIP is used as its own oracle. */
import { stdout } from "node:process";
import { createZipStream } from "../../../src/archive/write.ts";

const encoded = new TextEncoder();
const source = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoded.encode("first "));
    controller.enqueue(encoded.encode("second\n"));
    controller.close();
  },
});
const output = createZipStream([
  { name: "folder/", kind: "directory" },
  { name: "folder/é.txt", source },
  { name: "empty.txt" },
  { name: "binary.bin", source: new Uint8Array([0, 255, 1, 128]), size: 4 },
]);
// This fixture is deliberately small; production callers should pipe rather than collect.
stdout.write(new Uint8Array(await new Response(output).arrayBuffer()));
