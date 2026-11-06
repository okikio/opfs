/** Official Firebase SDK controls against the loopback emulator; no candidate imports. @module */
import { ok } from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";
type AppType = object;
type StorageType = object;
type ReferenceType = { fullPath: string };
type AppModuleType = {
  initializeApp(options: { projectId: string; apiKey: string; storageBucket: string }): AppType;
  deleteApp(app: AppType): Promise<void>;
};
type StorageModuleType = {
  getStorage(app: AppType): StorageType;
  connectStorageEmulator(
    storage: StorageType,
    host: string,
    port: number,
    options: { mockUserToken: { sub: string; user_id: string } },
  ): void;
  ref(storage: StorageType, name: string): ReferenceType;
  uploadBytes(ref: ReferenceType, bytes: Uint8Array): Promise<unknown>;
  getBytes(ref: ReferenceType): Promise<ArrayBuffer>;
  getMetadata(ref: ReferenceType): Promise<unknown>;
  list(ref: ReferenceType): Promise<{ items: ReferenceType[] }>;
};
const require = createRequire(import.meta.url),
  appModule: unknown = require("firebase/app"),
  storageModule: unknown = require("firebase/storage");
ok(
  appModule !== null && typeof appModule === "object" && "initializeApp" in appModule &&
    typeof appModule.initializeApp === "function" && "deleteApp" in appModule &&
    typeof appModule.deleteApp === "function",
);
ok(storageModule !== null && typeof storageModule === "object");
for (const name of ["getStorage", "connectStorageEmulator", "ref", "uploadBytes", "getBytes", "getMetadata", "list"]) {
  ok(name in storageModule && typeof Reflect.get(storageModule, name) === "function");
}
const apps = appModule as AppModuleType, sdk = storageModule as StorageModuleType;
const app = apps.initializeApp({
  projectId: "demo-opfs",
  apiKey: "fixture-not-a-production-key",
  storageBucket: "demo-opfs.appspot.com",
});
const storage = sdk.getStorage(app);
sdk.connectStorageEmulator(storage, "127.0.0.1", 9199, { mockUserToken: { sub: "fixture", user_id: "fixture" } });
try {
  const [action, name, value] = process.argv.slice(2);
  ok(name !== undefined);
  const target = sdk.ref(storage, name);
  if (action === "seed") {
    ok(value !== undefined);
    const bytes = new TextEncoder().encode(value);
    ok(bytes.length <= 1048576);
    await sdk.uploadBytes(target, bytes);
  } else if (action === "read") {
    const bytes = await sdk.getBytes(target);
    ok(bytes.byteLength <= 1048576);
    console.log(JSON.stringify(Array.from(new Uint8Array(bytes))));
  } else if (action === "metadata") console.log(JSON.stringify(await sdk.getMetadata(target)));
  else if (action === "list") console.log(JSON.stringify((await sdk.list(target)).items.map((item) => item.fullPath)));
  else throw Error("Unknown fixture operation.");
} finally {
  await apps.deleteApp(app);
}
