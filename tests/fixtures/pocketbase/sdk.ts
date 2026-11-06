/** Independent pinned PocketBase SDK calls; no candidate imports. @module */
import { ok } from "node:assert/strict";
import process from "node:process";
type RecordType = { id: string; [name: string]: unknown };
type PocketbaseType = {
  collection(
    name: string,
  ): {
    authWithPassword(email: string, password: string): Promise<unknown>;
    create(data: Record<string, unknown>): Promise<RecordType>;
    getOne(id: string): Promise<RecordType>;
  };
  collections: { create(data: Record<string, unknown>): Promise<unknown> };
  authStore: { token: string };
  files: {
    getToken(): Promise<string>;
    getURL(record: RecordType, filename: string, options: { token: string }): string;
  };
};
type ConstructorType = new (url: string) => PocketbaseType;
const modulePath = "./package/dist/pocketbase.es.mjs", imported: unknown = await import(modulePath);
ok(
  imported !== null && typeof imported === "object" && "default" in imported && typeof imported.default === "function",
);
const PocketBase = imported.default as ConstructorType, pb = new PocketBase("http://127.0.0.1:8090");
await pb.collection("_superusers").authWithPassword("fixture@example.invalid", "fixture-password-1234");
const [action, ...args] = process.argv.slice(2);
if (action === "setup") {
  await pb.collections.create({
    name: "fixture_users",
    type: "auth",
    passwordAuth: { enabled: true, identityFields: ["email"] },
  });
  const user = await pb.collection("fixture_users").create({
    email: "user@example.invalid",
    password: "user-password-1234",
    passwordConfirm: "user-password-1234",
  });
  for (
    const [name, protectedFile, viewRule, updateRule, deleteRule] of [["public_files", false, "", null, null], [
      "private_files",
      true,
      '@request.auth.id != ""',
      null,
      null,
    ], ["update_only", false, "", '@request.auth.id != ""', null]] as const
  ) {
    await pb.collections.create({
      name,
      type: "base",
      listRule: "",
      viewRule,
      createRule: null,
      updateRule,
      deleteRule,
      fields: [{ name: "documents", type: "file", maxSelect: 10, maxSize: 1048576, protected: protectedFile }, {
        name: "title",
        type: "text",
      }],
    });
    const record = await pb.collection(name).create({
      title: "native producer",
      documents: [new File(["independent official PocketBase SDK producer bytes\n"], "producer.txt")],
    });
    console.log(JSON.stringify({ collection: name, record }));
  }
  const ordinary = new PocketBase("http://127.0.0.1:8090");
  await ordinary.collection("fixture_users").authWithPassword("user@example.invalid", "user-password-1234");
  console.log(JSON.stringify({ admin: pb.authStore.token, user: ordinary.authStore.token, userId: user.id }));
} else if (action === "read") {
  const [collection, id, filename] = args;
  ok(collection && id && filename);
  const record = await pb.collection(collection).getOne(id), token = await pb.files.getToken();
  const response = await fetch(pb.files.getURL(record, filename, { token }));
  ok(response.ok);
  const bytes = await response.arrayBuffer();
  ok(bytes.byteLength <= 1048576);
  console.log(JSON.stringify(Array.from(new Uint8Array(bytes))));
} else if (action === "get") {
  const [collection, id] = args;
  ok(collection && id);
  console.log(JSON.stringify(await pb.collection(collection).getOne(id)));
} else throw Error("Unknown fixture SDK action.");
