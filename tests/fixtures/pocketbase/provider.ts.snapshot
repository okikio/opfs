import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Official Node24.15.0 Alpine multiarch index, inspected with buildx2026-11-05. */
export const POCKETBASE_IMAGE = "node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f";
export const POCKETBASE_BYTES = "independent official PocketBase SDK producer bytes\n";
const PORT = 8090;
/** Artifact downloads are finite and checked before either native executable or test SDK is extracted. */
const download = `import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const binaries={arm64:'d22c66ceb67ca92b7d767f36d826e848a276bcfa3c197ead20bf87c42208984f',x64:'0e1f609158ed945f809f8a02ae012aa0427129c66ebb63c1aee76f2c0309373f'};
const hash=binaries[process.arch];if(!hash)throw Error('Unsupported native fixture architecture');
for(const [url,path,algorithm,expected,encoding] of [
['https://github.com/pocketbase/pocketbase/releases/download/v0.40.6/pocketbase_0.40.6_linux_'+(process.arch==='x64'?'amd64':'arm64')+'.zip','server.zip','sha256',hash,'hex'],
['https://registry.npmjs.org/pocketbase/-/pocketbase-0.28.1.tgz','sdk.tgz','sha512','/3ihkq+rvfcs0MQgrK4sEElOg6gfenHW9S/O+3BSO+V1yT+4B10+9aT22uTQUPqze9ItwNtwWyY5ZmdgVCTdVA==','base64']]) {
const response=await fetch(url);if(!response.ok||!response.body){const failure=Error('Official fixture download failed');try{await response.body?.cancel(failure);}catch(cleanup){throw new AggregateError([failure,cleanup],'Fixture download and cleanup failed');}throw failure;}
const chunks=[];let count=0;for await(const chunk of response.body){count+=chunk.length;if(count>32*1024*1024)throw Error('Fixture artifact exceeds bound');chunks.push(chunk);}
const bytes=Buffer.concat(chunks);if(createHash(algorithm).update(bytes).digest(encoding)!==expected)throw Error('Official fixture artifact hash differs');await writeFile(path,bytes);
}`;
/** Official SDK owns schema creation, producer upload, independent reader and authentication in this disposable server. */
const sdk = `import PocketBase from './package/dist/pocketbase.es.mjs';
const pb=new PocketBase('http://127.0.0.1:8090');
await pb.collection('_superusers').authWithPassword('fixture@example.invalid','fixture-password-1234');
const [action,...args]=process.argv.slice(2);
if(action==='setup') {
await pb.collections.create({name:'fixture_users',type:'auth',passwordAuth:{enabled:true,identityFields:['email']}});
const user=await pb.collection('fixture_users').create({email:'user@example.invalid',password:'user-password-1234',passwordConfirm:'user-password-1234'});
for(const [name,protectedFile,viewRule,updateRule,deleteRule] of [
['public_files',false,'',null,null],
['private_files',true,'@request.auth.id != ""',null,null],
['update_only',false,'','@request.auth.id != ""',null]]) {
await pb.collections.create({name,type:'base',listRule:'',viewRule,createRule:null,updateRule,deleteRule,fields:[{name:'documents',type:'file',maxSelect:10,maxSize:1048576,protected:protectedFile},{name:'title',type:'text'}]});
const result=await pb.collection(name).create({title:'native producer',documents:[new File([${
  JSON.stringify(POCKETBASE_BYTES)
}],'producer.txt')]});
console.log(JSON.stringify({collection:name,record:result}));
}
const ordinary=new PocketBase('http://127.0.0.1:8090');await ordinary.collection('fixture_users').authWithPassword('user@example.invalid','user-password-1234');
console.log(JSON.stringify({admin:pb.authStore.token,user:ordinary.authStore.token,userId:user.id}));
} else if(action==='read') {
const [collection,id,filename]=args,record=await pb.collection(collection).getOne(id);
const token=await pb.files.getToken();const response=await fetch(pb.files.getURL(record,filename,{token}));if(!response.ok)throw Error('SDK file read failed');console.log(JSON.stringify(Array.from(new Uint8Array(await response.arrayBuffer()))));
} else if(action==='get') console.log(JSON.stringify(await pb.collection(args[0]).getOne(args[1])));
else throw Error('Unknown fixture SDK action');
`;
const dockerfile = `FROM ${POCKETBASE_IMAGE}
WORKDIR /fixture
COPY download.mjs sdk.mjs ./
RUN node download.mjs && unzip server.zip pocketbase && tar -xzf sdk.tgz && rm server.zip sdk.tgz && chmod 755 pocketbase && chown -R node:node /fixture
USER node
CMD ["sh","-c","./pocketbase superuser upsert fixture@example.invalid fixture-password-1234 --dir=/fixture/data && exec ./pocketbase serve --http=0.0.0.0:8090 --dir=/fixture/data"]
`;
/** The caller owns fixture disposal. No host account, Git configuration or globally installed tool enters the server. */
export class PocketbaseFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}/`;
  }
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  async sdk(action: "setup" | "read" | "get", ...args: string[]): Promise<readonly unknown[]> {
    const result = await this.#container.exec(["node", "/fixture/sdk.mjs", action, ...args]);
    if (result.exitCode !== 0) throw new Error(`Independent PocketBase SDK failed: ${result.output}`);
    return result.stdout.trim().split("\n").map((line) => JSON.parse(line) as unknown);
  }
}
/** Testcontainers owns genuine server startup, ephemeral port readiness and complete cleanup after partial failure. */
export async function openPocketbaseFixture(): Promise<PocketbaseFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const directory = await mkdtemp(join(tmpdir(), "opfs-pocketbase-"));
  let container: StartedTestContainer | undefined;
  try {
    await Promise.all([
      writeFile(join(directory, "Dockerfile"), dockerfile),
      writeFile(join(directory, "download.mjs"), download),
      writeFile(join(directory, "sdk.mjs"), sdk),
    ]);
    const built = await GenericContainer.fromDockerfile(directory).build();
    await rm(directory, { recursive: true, force: true });
    container = await built.withExposedPorts(PORT).withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withResourcesQuota({ memory: 0.5, cpu: 1 }).withWaitStrategy(
        Wait.forHttp("/api/health", PORT).forStatusCode(200),
      ).withStartupTimeout(90_000).start();
    return new PocketbaseFixture(container);
  } catch (reason) {
    await close([
      ...(container === undefined ? [] : [() => container!.stop()]),
      () => rm(directory, { recursive: true, force: true }),
    ], [reason]);
    throw reason;
  }
}
