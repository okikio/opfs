import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Official multiarch image indexes verified using buildx on 2026-11-05. */
export const FIREBASE_NODE_IMAGE = "node@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d";
export const FIREBASE_JRE_IMAGE =
  "eclipse-temurin@sha256:0eda5830ed7b669abc246a8dc520ea8a23cab06f9a8d4b6964109e2f2394e46f";
export const FIREBASE_BUCKET = "demo-opfs.appspot.com";
export const FIREBASE_BYTES = "independent Firebase SDK producer bytes";
/** Unsigned emulator-only token; never valid Firebase production authentication. */
export const FIREBASE_TEST_TOKEN = [
  { alg: "none", typ: "JWT" },
  {
    sub: "fixture",
    user_id: "fixture",
    aud: "demo-opfs",
    iss: "https://securetoken.google.com/demo-opfs",
    iat: 0,
    exp: 4102444800,
  },
].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".";
const PORT = 9199;
/** Test-only tools remain inside this disposable container, outside the production dependency graph. */
const DOWNLOAD = `
import {createHash} from 'node:crypto'; import {writeFile,mkdir} from 'node:fs/promises';
for (const [url,path,algorithm,expected] of [
['https://registry.npmjs.org/firebase-tools/-/firebase-tools-15.35.0.tgz','/fixture/tools.tgz','sha512','grcjoqNsJoWTTu+YEuM8BScOM7c5lM1XCFenmz0RhNEyJVoj8dTslPy7sx5Hct69+9OAKJb70qZ3JTHZFw+3zQ=='],
['https://registry.npmjs.org/firebase/-/firebase-13.2.0.tgz','/fixture/sdk.tgz','sha512','29ye5F+viPTv48mcljy84ZnwnrYmTTIULrWf3P113SfeTB/USIUZTs8gREreN5PmndQdKs3D06KQUPJIrFeTGw=='],
['https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-storage-rules-runtime-v1.1.3.jar','/root/.cache/firebase/emulators/cloud-storage-rules-runtime-v1.1.3.jar','sha256','0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900']]) {
const response=await fetch(url);if(!response.ok)throw Error('Fixture download failed'); const bytes=Buffer.from(await response.arrayBuffer());
const actual=createHash(algorithm).update(bytes).digest(algorithm==='sha512'?'base64':'hex');if(actual!==expected)throw Error('Fixture download hash differs');
await mkdir(path.slice(0,path.lastIndexOf('/')),{recursive:true});await writeFile(path,bytes);
}`;
const SDK = `
import {initializeApp,deleteApp} from 'firebase/app';
import {getStorage,connectStorageEmulator,ref,uploadBytes,getBytes,getMetadata,list} from 'firebase/storage';
const app=initializeApp({projectId:'demo-opfs',apiKey:'fixture-not-a-production-key',storageBucket:'${FIREBASE_BUCKET}'});
const storage=getStorage(app);connectStorageEmulator(storage,'127.0.0.1',9199,{mockUserToken:{sub:'fixture',user_id:'fixture'}});
try {
const [action,name,value]=process.argv.slice(2),target=ref(storage,name);
if(action==='seed') await uploadBytes(target,new TextEncoder().encode(value));
else if(action==='read') console.log(JSON.stringify(Array.from(new Uint8Array(await getBytes(target)))));
else if(action==='metadata') console.log(JSON.stringify(await getMetadata(target)));
else if(action==='list') console.log(JSON.stringify((await list(target)).items.map(item=>item.fullPath)));
else throw Error('Unknown fixture operation');
} finally {await deleteApp(app);}
`;
const rules =
  `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /allowed/{allPaths=**} { allow read, write: if true; } match /authenticated/{allPaths=**} { allow read, write: if request.auth.uid == 'fixture'; } match /denied/{allPaths=**} { allow read, write: if false; } } }`;
const config = JSON.stringify({
  storage: { rules: "storage.rules" },
  emulators: { storage: { host: "0.0.0.0", port: PORT }, ui: { enabled: false }, singleProjectMode: true },
});
const dockerfile = `FROM ${FIREBASE_NODE_IMAGE} AS node
FROM ${FIREBASE_JRE_IMAGE}
COPY --from=node /usr/local/ /usr/local/
WORKDIR /fixture
COPY download.mjs sdk.mjs storage.rules firebase.json ./
RUN node download.mjs && npm install --ignore-scripts --no-audit --no-fund ./tools.tgz ./sdk.tgz && rm tools.tgz sdk.tgz
ENV CI=true FIREBASE_CLI_DISABLE_UPDATE_CHECK=true FIREBASE_CLI_EXPERIMENTS=""
CMD ["node","node_modules/firebase-tools/lib/bin/firebase.js","emulators:start","--only","storage","--project","demo-opfs","--config","/fixture/firebase.json"]
`;
/** Testcontainers owns one real Firebase emulator and its independent SDK producer/reader. */
export class FirebaseFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}/v0/`;
  }
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /** Official SDK over the loopback emulator. No candidate client code creates or reads the oracle bytes. */
  async sdk(action: "seed" | "read" | "metadata" | "list", name: string, value = ""): Promise<string> {
    const result = await this.#container.exec(["node", "/fixture/sdk.mjs", action, name, value]);
    if (result.exitCode !== 0) throw new Error(`Independent Firebase SDK failed: ${result.output}`);
    return result.stdout.trim();
  }
}
/** Reproducible primary artifact pins; npm resolves test-tool transitive dependencies during build, not production. */
export async function openFirebaseFixture(): Promise<FirebaseFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const directory = await mkdtemp(join(tmpdir(), "opfs-firebase-"));
  let container: StartedTestContainer | undefined;
  try {
    await Promise.all([
      writeFile(join(directory, "Dockerfile"), dockerfile),
      writeFile(join(directory, "download.mjs"), DOWNLOAD),
      writeFile(join(directory, "sdk.mjs"), SDK),
      writeFile(join(directory, "storage.rules"), rules),
      writeFile(join(directory, "firebase.json"), config),
    ]);
    const built = await GenericContainer.fromDockerfile(directory).build();
    await rm(directory, { recursive: true, force: true });
    container = await built.withExposedPorts(PORT).withWaitStrategy(Wait.forLogMessage("All emulators ready!"))
      .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withResourcesQuota({ memory: 0.75, cpu: 1 }).withStartupTimeout(120_000).start();
    return new FirebaseFixture(container);
  } catch (reason) {
    await close([
      ...(container === undefined ? [] : [() => container!.stop()]),
      () => rm(directory, { recursive: true, force: true }),
    ], [reason]);
    throw reason;
  }
}
