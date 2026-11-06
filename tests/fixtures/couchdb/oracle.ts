/** Nano owns HTTP and attachment semantics; the fixture owns only admission, bytes and deadline. @module */
import { ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
type NanoType = {
  info(): Promise<{ version: string }>;
  db: { create(name: string): Promise<unknown> };
  use(
    name: string,
  ): {
    attachment: {
      insert(id: string, name: string, bytes: Buffer, media: string): Promise<unknown>;
      get(id: string, name: string): Promise<Buffer>;
    };
  };
};
type FactoryType = (options: { url: string; headers: { Authorization: string } }) => NanoType;
const imported: unknown = createRequire(import.meta.url)("nano");
ok(typeof imported === "function");
const Nano = imported as FactoryType;
const timer = setTimeout(() => {
  console.error("oracle deadline");
  process.exit(2);
}, 30_000);
try {
  const server = Nano({
      url: "http://couchdb.test:5984",
      headers: { Authorization: "Basic " + Buffer.from("fixture:disposable-only").toString("base64") },
    }),
    db = server.use("fixture"),
    [operation, id, name] = process.argv.slice(2);
  if (operation === "init") {
    const value = await server.info();
    ok(value.version === "3.5.3");
    await server.db.create("fixture");
    console.log("VERSION:" + value.version);
  } else if (operation === "seed") {
    ok(id && name);
    const info = lstatSync("/oracle/input.bin");
    ok(info.isFile() && info.size <= 1048576);
    const bytes = readFileSync("/oracle/input.bin");
    ok(bytes.length <= 1048576);
    const receipt = await db.attachment.insert(id, encodeURIComponent(name), bytes, "application/octet-stream");
    console.log("RECEIPT:" + JSON.stringify(receipt));
  } else if (operation === "read") {
    ok(id && name);
    const bytes = await db.attachment.get(id, encodeURIComponent(name));
    ok(bytes.length <= 1048576);
    console.log("BYTES:" + bytes.toString("base64"));
  } else throw Error("Unsupported fixture action.");
} finally {
  clearTimeout(timer);
}
