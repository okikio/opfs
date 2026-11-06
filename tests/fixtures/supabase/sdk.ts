/** Official storage-js SDK with explicit private-network Fetch transport. @module */
import { ok } from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";
type ResultType<T> = { error: unknown; data: T };
type StorageType = {
  createBucket(name: string, options: { public: boolean }): Promise<ResultType<unknown>>;
  from(
    bucket: string,
  ): {
    upload(
      path: string,
      data: Uint8Array,
      options: { contentType: string; upsert: boolean },
    ): Promise<ResultType<unknown>>;
    download(path: string): Promise<ResultType<Blob>>;
    list(path: string): Promise<ResultType<unknown>>;
  };
};
type ConstructorType = new (url: string, headers: Record<string, string>, transport: typeof fetch) => StorageType;
const imported: unknown = createRequire(import.meta.url)("./package/dist/main/index.js");
ok(
  imported !== null && typeof imported === "object" && "StorageClient" in imported &&
    typeof imported.StorageClient === "function",
);
const StorageClient = imported.StorageClient as ConstructorType;
const transport: typeof fetch = (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  ok(
    target.origin === "http://storage:5000" && target.pathname.startsWith("/storage/v1/"),
    "Unexpected SDK fixture route.",
  );
  target.pathname = target.pathname.slice("/storage/v1".length);
  return fetch(target, init);
};
ok(process.env.SERVICE_TOKEN);
const storage = new StorageClient("http://storage:5000/storage/v1", {
    Authorization: "Bearer " + process.env.SERVICE_TOKEN,
  }, transport),
  [action, ...args] = process.argv.slice(2);
function checked<T>(result: ResultType<T>): T {
  if (result.error) throw result.error;
  return result.data;
}
if (action === "setup") {
  checked(await storage.createBucket("private", { public: false }));
  checked(await storage.createBucket("public", { public: true }));
  for (
    const [bucket, path] of [["private", "allowed/oracle.txt"], ["private", "hidden/oracle.txt"], [
      "public",
      "oracle.txt",
    ]] as const
  ) {
    checked(
      await storage.from(bucket).upload(
        path,
        new TextEncoder().encode("independent official storage-js producer bytes\n"),
        { contentType: "text/plain", upsert: false },
      ),
    );
  }
  console.log("true");
} else if (action === "read") {
  const [bucket, path] = args;
  ok(bucket && path);
  const blob = checked(await storage.from(bucket).download(path));
  ok(blob.size <= 1048576);
  console.log(JSON.stringify(Array.from(new Uint8Array(await blob.arrayBuffer()))));
} else if (action === "list") {
  const [bucket, path] = args;
  ok(bucket && path !== undefined);
  console.log(JSON.stringify(checked(await storage.from(bucket).list(path))));
} else throw Error("Unknown SDK fixture action.");
