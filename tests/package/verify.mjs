import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { undent } from "@okikio/undent";
import { runProgram } from "../../bench/process.ts";

const argument = process.argv[2];
if (argument === undefined || argument.length === 0) {
  throw new Error("Pass the npm tarball path.");
}
const tarball = resolve(argument);

/** Runs one child command and rejects when it exits unsuccessfully. */
function command(file, args, options = {}) {
  return runProgram(file, args, { stdio: "inherit", ...options });
}

/** Returns true when the executable can be started in this environment. */
async function hasCommand(file) {
  try {
    await command(file, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Lists every regular file below one extracted package directory. */
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

/** Releases every acquired resource in reverse order without losing any rejection reason. */
async function finish(releases, failures = []) {
  for (const release of releases.toReversed()) {
    try {
      await release();
    } catch (reason) {
      failures.push(reason);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Package fixture and owned cleanup failed.",
      { cause: failures[0] },
    );
  }
}

const workspace = await mkdtemp(join(tmpdir(), "okikio-opfs-package-"));
const failures = [];
try {
  const extracted = join(workspace, "extracted");
  await command("mkdir", ["-p", extracted]);
  await command("tar", ["-xzf", tarball, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  await readFile(join(packageRoot, "LICENSE"), "utf8");
  await readFile(join(packageRoot, "CHANGELOG.md"), "utf8");
  // A reader must be able to follow the local documentation links in the installed package.
  for (
    const match of readme.matchAll(/\]\((?:\.\/)?(docs\/[^)#]+)(?:#[^)]*)?\)/gu)
  ) {
    await readFile(join(packageRoot, match[1]), "utf8");
  }

  if (manifest.name !== "@okikio/opfs") {
    throw new Error(`Unexpected npm package name: ${manifest.name}`);
  }
  if (manifest.dependencies?.["drizzle-orm"]) {
    throw new Error("drizzle-orm must not be a normal npm dependency.");
  }
  if (!manifest.peerDependencies?.["drizzle-orm"]) {
    throw new Error("drizzle-orm optional peer is missing.");
  }
  if (manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional !== true) {
    throw new Error("drizzle-orm must be marked as an optional peer.");
  }
  if (!manifest.dependencies?.zod) {
    throw new Error("zod runtime dependency is missing.");
  }
  if (manifest.dependencies?.["deno-types"] !== "npm:@types/deno@2.7.0") {
    throw new Error(
      "The native Deno leaf requires its reviewed published declaration dependency.",
    );
  }
  for (
    const field of ["dependencies", "peerDependencies", "optionalDependencies"]
  ) {
    if (manifest[field]?.["@types/deno"]) {
      throw new Error(
        "Native Deno declarations must not enter automatic portable ambient discovery.",
      );
    }
    if (manifest[field]?.["@deno/shim-deno"]) {
      throw new Error(
        "Native Deno APIs must not become an installed runtime shim.",
      );
    }
  }

  for (
    const field of ["dependencies", "peerDependencies", "optionalDependencies"]
  ) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith("@jsr/")) {
        throw new Error(
          `npm tarball leaked JSR compatibility dependency '${name}' through ${field}.`,
        );
      }
    }
  }

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const entry = typeof target === "string" ? { default: target } : target;
    for (const field of ["types", "import", "default"]) {
      const path = entry?.[field];
      if (path === undefined) continue;
      if (field === "types" && !path.endsWith(".d.ts")) {
        throw new Error(`${subpath} types do not point to .d.ts: ${path}`);
      }
      if (field !== "types" && !path.endsWith(".js")) {
        throw new Error(`${subpath} runtime does not point to .js: ${path}`);
      }
      await stat(join(packageRoot, path));
    }
  }

  const publishedFiles = await walk(packageRoot);
  const rawTs = publishedFiles.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));
  if (rawTs.length > 0) {
    throw new Error(`npm tarball contains raw TypeScript: ${rawTs.join(", ")}`);
  }
  for (const path of publishedFiles.filter((path) => path.endsWith(".js"))) {
    if ((await readFile(path, "utf8")).includes("@deno/shim-deno")) {
      throw new Error(
        `Published JavaScript contains a Deno runtime shim: ${path}`,
      );
    }
  }
  const nativeEntry = manifest.exports?.["./driver/deno"]?.import;
  if (typeof nativeEntry !== "string" || !nativeEntry.endsWith(".js")) {
    throw new Error("The packed native Deno ESM entrypoint is missing.");
  }
  const nativeDeclaration = await readFile(
    join(packageRoot, nativeEntry.replace(/\.js$/u, ".d.ts")),
    "utf8",
  );
  if (!nativeDeclaration.startsWith('/// <reference types="deno-types" />\n')) {
    throw new Error(
      "The native Deno type directive must precede every import and declaration.",
    );
  }

  const consumer = join(workspace, "consumer");
  await command("mkdir", ["-p", consumer]);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ], { cwd: consumer });

  await writeFile(
    join(consumer, "smoke.mjs"),
    undent`
    import { createFileSystem } from '@okikio/opfs';
    import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
    import { normalizePath } from '@okikio/opfs/path';
    import { createByteSource } from '@okikio/opfs/source';
    import { testByteSource } from '@okikio/opfs/testing/source';
    import { createNativeTink } from '@okikio/opfs/crypto/tink';
    import { createTarStream, readTarStream } from '@okikio/opfs/archive/stream';
    import { openTar } from '@okikio/opfs/archive/tar';
    import { createTarAdapter } from '@okikio/opfs/view/tar';
    import { openCpio } from '@okikio/opfs/archive/cpio';
    import { createCpioAdapter } from '@okikio/opfs/view/cpio';
    import { DriveClient } from '@okikio/opfs/drive';
    import { OnedriveClient } from '@okikio/opfs/onedrive';
    import { OciClient } from '@okikio/opfs/oci';
    import { openCab } from '@okikio/opfs/archive/cab';
    import { openWarc } from '@okikio/opfs/archive/warc';
    import { openMime } from '@okikio/opfs/archive/mime';
    import { openSeven } from '@okikio/opfs/archive/seven';
    import { openAr } from '@okikio/opfs/archive/ar';
    import { openMbox } from '@okikio/opfs/archive/mbox';
    import { FtpClient } from '@okikio/opfs/ftp';
    import { createD1Adapter } from '@okikio/opfs/adapter/d1';
    import { createZipStream } from '@okikio/opfs/archive/write';
    import { openZip } from '@okikio/opfs/archive/zip';
    import { compressStream, decompressStream } from '@okikio/opfs/archive/compress';
    import { parseCid, verifyBlock } from '@okikio/opfs/content/cid';
    import { createS3Client } from '@okikio/opfs/s3';
    import { createS3UploadDestination } from '@okikio/opfs/transfer/s3';
    import { createAzureClient } from '@okikio/opfs/azure';
    import { createAzureUploadDestination } from '@okikio/opfs/transfer/azure';
    ${finish.toString()}
    const failures = [], releases = [];
    let writer;
    try {
    const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: 'local' });
    releases.push(() => fileSystem.close());
    const bytes = Uint8Array.from({ length: 65537 }, (_, index) => index % 251);
    await testByteSource(() => ({
      source: createByteSource(new Uint8Array([2, 3, 5, 7])),
      expected: new Uint8Array([2, 3, 5, 7]),
      close() {},
    }));
    const profile = createNativeTink();
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const aad = new TextEncoder().encode('packed-consumer-v1');
    const ciphertext = new Uint8Array(await new Response(profile.encrypt(createByteSource(bytes), key, aad)).arrayBuffer());
    const encrypted = await profile.open(createByteSource(ciphertext), key, aad);
    const selected = await encrypted.readVerified(65530, 7);
    if (selected.scope !== 'authenticated-segments' || selected.bytes.some((value, index) => value !== bytes[65530 + index])) {
      throw new Error('Packed authenticated range mismatch');
    }
    await fileSystem.writeFile('/state/file.bin', bytes, { parents: true });
    const assertBytes = (actual, expected) => {
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error('Packed consumer bytes differ');
      }
    };
    const archivePayload = bytes.slice(0, 1024);
    const compressed = new Uint8Array(await new Response(compressStream(
      new Blob([archivePayload]).stream(), 'gzip'
    )).arrayBuffer());
    assertBytes(new Uint8Array(await new Response(decompressStream(
      new Blob([compressed]).stream(), 'gzip'
    )).arrayBuffer()), archivePayload);
    const helloCid = parseCid('f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    await verifyBlock(helloCid.id, new TextEncoder().encode('hello'));
    let unexpectedS3Calls = 0;
    const s3 = createS3Client({
      endpoint: 'https://fixture.invalid', bucket: 'test', region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      fetch: async () => { unexpectedS3Calls++; throw new Error('Construction performed I/O'); },
    });
    const upload = createS3UploadDestination(s3, {
      version: 1, backend: s3.identity, key: 'test', id: 'test',
      token: 'packed_consumer_unique_session_001', size: 3, partBytes: 5 * 1024 * 1024,
    });
    if (unexpectedS3Calls || upload.protocol !== 's3-multipart-v1') {
      throw new Error('Packed S3 continuation construction contract failed');
    }
    const azure = createAzureClient({
      endpoint: 'https://fixture.invalid', container: 'test',
      credential: { kind: 'sas', token: 'sv=test' },
      fetch: async () => { throw new Error('Construction performed I/O'); },
    });
    const azureUpload = createAzureUploadDestination(azure, {
      version: 1, backend: azure.identity, key: 'test', token: 'packed_consumer_azure_session_001',
      size: 3, blockBytes: 4 * 1024 * 1024, initialETag: null,
    });
    if (azureUpload.protocol !== 'azure-blocks-v1' || azureUpload.terminate !== undefined) {
      throw new Error('Packed Azure continuation construction contract failed');
    }
    new DriveClient({ token: () => { throw new Error('Construction obtained credentials'); } });
    const tarViewBytes = new Uint8Array(await new Response(createTarStream([
      { name: 'notes/hello.txt', size: 3, body: new Blob([new Uint8Array([1,2,3])]).stream() }
    ])).arrayBuffer());
    const tarView = createFileSystem(createTarAdapter(await openTar(createByteSource(tarViewBytes))));
    releases.push(() => tarView.close());
    assertBytes(await tarView.readFile('/notes/hello.txt', { at: 1, length: 2 }), new Uint8Array([2,3]));
    // CPIO fixture bytes come from the independent GNU producer retained by the repository.
    const cpioFixture = ${
      JSON.stringify(JSON.parse(await readFile(new URL("../fixtures/cpio/gnu.json", import.meta.url), "utf8")).crc)
    };
    const cpioBytes = Uint8Array.from(atob(cpioFixture.archive), (byte) => byte.charCodeAt(0));
    const cpioArchive = await openCpio(createByteSource(cpioBytes));
    const cpioView = createFileSystem(createCpioAdapter({ ...cpioArchive, entries: cpioArchive.entries.filter((entry) => entry.kind === 'file' || entry.kind === 'directory') }));
    releases.push(() => cpioView.close());
    const cpioExpected = Uint8Array.from(atob(cpioFixture.entries.find((entry) => entry.name === 'folder/data.bin').body), (byte) => byte.charCodeAt(0));
    assertBytes(await cpioView.readFile('/folder/data.bin', { length: 7 }), cpioExpected.slice(0,7));
    new OnedriveClient({ driveId: 'packed', token: () => { throw new Error('Construction obtained OAuth'); } });
    const cabFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/cab/independent.json", import.meta.url), "utf8")).stored,
      )
    };
    const cabArchive = await openCab(createByteSource(Uint8Array.from(atob(cabFixture.archive), (byte) => byte.charCodeAt(0))));
    assertBytes((await cabArchive.read(0)).bytes, Uint8Array.from(atob(cabFixture.entries[0].body), (byte) => byte.charCodeAt(0)));
    const warcFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/warc/independent.json", import.meta.url), "utf8")).archives[1],
      )
    };
    const warcArchive = await openWarc(createByteSource(Uint8Array.from(atob(warcFixture.base64), (byte) => byte.charCodeAt(0))));
    assertBytes((await warcArchive.read(1)).bytes, Uint8Array.from(atob(warcFixture.records[1].blockBase64), (byte) => byte.charCodeAt(0)));
    if ((await warcArchive.verifyBlock(1, { subtle: globalThis.crypto.subtle })).integrity !== 'stored-block-digest') throw new Error('Packed WARC block proof failed');
    const mimeFixture = ${
      JSON.stringify(JSON.parse(await readFile(new URL("../fixtures/mime/independent.json", import.meta.url), "utf8")))
    };
    const mimeArchive = await openMime(createByteSource(Uint8Array.from(atob(mimeFixture.base64), (byte) => byte.charCodeAt(0))));
    const mimeAttachment = mimeArchive.entries.find((entry) => entry.filenameStatus === 'decoded');
    if (!mimeAttachment) throw new Error('Packed MIME attachment missing');
    assertBytes((await mimeArchive.read(mimeAttachment.id)).bytes, Uint8Array.from(atob(mimeFixture.parts.find((part) => part.filename === mimeAttachment.filename).payloadBase64), (byte) => byte.charCodeAt(0)));
    const sevenFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/seven/independent.json", import.meta.url), "utf8")).copy,
      )
    };
    const sevenArchive = await openSeven(createByteSource(Uint8Array.from(atob(sevenFixture.archive), (byte) => byte.charCodeAt(0))));
    const sevenFile = sevenArchive.entries.find((entry) => entry.kind === 'file' && entry.readable && entry.size > 0);
    if (!sevenFile) throw new Error('Packed 7z COPY missing');
    assertBytes((await sevenArchive.read(sevenFile.id)).bytes, Uint8Array.from(atob(sevenFixture.entries.find((entry) => entry.name === sevenFile.name).body), (byte) => byte.charCodeAt(0)));
    const arFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/ar/independent.json", import.meta.url), "utf8")).gnu,
      )
    };
    const arArchive = await openAr(createByteSource(Uint8Array.from(atob(arFixture.archive), (byte) => byte.charCodeAt(0))));
    const arFile = arArchive.entries.find((entry) => entry.name === 'first.bin');
    assertBytes(await arArchive.member(arFile.id).read(0, arFile.size), Uint8Array.from(atob(arFixture.entries.find((entry) => entry.name === 'first.bin').body), (byte) => byte.charCodeAt(0)));
    const mboxFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/mbox/independent.json", import.meta.url), "utf8")).mboxrd,
      )
    };
    const mailbox = await openMbox(createByteSource(Uint8Array.from(atob(mboxFixture.base64), (byte) => byte.charCodeAt(0))), { dialect: 'mboxrd' });
    const message = await mailbox.openMessage(1, { trailing: 'remove-one' });
    const messageMime = await openMime(message.source);
    assertBytes((await messageMime.read(0)).bytes, new Uint8Array([0,1,2,3,255]));
    const ftp = new FtpClient({ host: 'fixture.invalid', username: 'user', password: 'password', mode: 'plain', transport: { connect() { throw new Error('FTP construction acquired a socket'); } } });
    await ftp.close();
    const packedOciManifest = JSON.stringify({"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.empty.v1+json","digest":"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},"layers":[{"mediaType":"application/octet-stream","digest":"sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81","size":3}]});
    const packedOci = new OciClient({
      registry: 'https://registry.invalid/', repository: 'packed/artifact',
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/v2/packed/artifact/manifests/release') return new Response(packedOciManifest, { headers: { 'Content-Type': 'application/vnd.oci.image.manifest.v1+json' } });
        if (url.pathname === '/v2/packed/artifact/blobs/sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81') return new Response(new Uint8Array([1,2,3]));
        throw new Error('Unexpected packed OCI request');
      },
    });
    const packedManifest = await packedOci.getManifest('release');
    const packedSource = await packedOci.openBlobSource(packedManifest.layers[0].digest, { size: 3 });
    assertBytes(await packedSource.read(1, 2), new Uint8Array([2,3]));
    void createD1Adapter;
    const tarName = 'caf\u00e9/' + 'long-name-'.repeat(20);
    let tarMembers = 0;
    const tarScan = await readTarStream(createTarStream([
      { name: tarName, size: archivePayload.length, body: new Blob([archivePayload]).stream() },
      { name: 'empty/', kind: 'directory', size: 0 },
    ]), async (entry, body) => {
      tarMembers++;
      let offset = 0;
      for await (const chunk of body) {
        assertBytes(chunk, archivePayload.subarray(offset, offset + chunk.length));
        offset += chunk.length;
      }
      if (entry.kind === 'file' && (entry.name !== tarName || offset !== archivePayload.length)) {
        throw new Error('Packed PAX TAR member mismatch');
      }
    }, { bodyChunkBytes: 31, maxOutputBytes: 1024 });
    if (!tarScan.complete || tarMembers !== 2 || tarScan.work.outputBytes !== 1024) {
      throw new Error('Packed one-shot TAR scan mismatch');
    }
    const zipBytes = new Uint8Array(await new Response(createZipStream([
      { name: 'payload.bin', size: archivePayload.length, source: archivePayload },
      { name: 'empty/', kind: 'directory' },
    ])).arrayBuffer());
    const zip = await openZip(createByteSource(zipBytes));
    const zipRead = await zip.read(0);
    assertBytes(zipRead.bytes, archivePayload);
    if (zip.entries.length !== 2 || zipRead.integrity !== 'checksum-verified') {
      throw new Error('Packed streaming ZIP verification mismatch');
    }
    assertBytes(await fileSystem.readFile('/state/file.bin'), bytes);
    assertBytes(await fileSystem.readFile('/state/file.bin', { at: 65530, length: 7 }), bytes.slice(65530));
    await fileSystem.copy('/state/file.bin', '/copy.bin');
    await fileSystem.move('/copy.bin', '/moved.bin');
    assertBytes(await fileSystem.readFile('/moved.bin'), bytes);
    if (await fileSystem.exists('/copy.bin')) throw new Error('Move retained the source');
    const handle = await fileSystem.getFileHandle('/moved.bin');
    writer = await handle.createWritable({ keepExistingData: true });
    releases.push(async () => { if (writer !== undefined) await writer.abort(); });
    await writer.write({ type: 'write', position: 0, data: new Uint8Array([255]) });
    await writer.abort();
    writer = undefined;
    assertBytes(await fileSystem.readFile('/moved.bin'), bytes);
    const signal = AbortSignal.abort();
    let aborted = false;
    try { await fileSystem.writeFile('/aborted.bin', bytes, { signal }); } catch (error) {
      aborted = error.code === 'aborted';
    }
    if (!aborted || await fileSystem.exists('/aborted.bin')) throw new Error('Aborted write published data');
    if (normalizePath('a/../b') !== '/b') throw new Error('npm path smoke failed');
    await import('@okikio/opfs/adapter/node');
    await import('@okikio/opfs/adapter/deno');
    await import('@okikio/opfs/adapter/bun');
    } catch (reason) { failures.push(reason); }
    finally { await finish(releases, failures); }
    console.log('Packed memory workflow passed');
`,
  );
  await command("node", ["smoke.mjs"], { cwd: consumer });

  const hasDeno = await hasCommand("deno");
  const hasBun = await hasCommand("bun");
  if (!hasDeno || !hasBun) {
    throw new Error(
      "Package verification requires actual Node, Deno, and Bun runtimes.",
    );
  }
  if (hasDeno) {
    await command("deno", [
      "run",
      "--no-config",
      "--node-modules-dir=manual",
      "smoke.mjs",
    ], {
      cwd: consumer,
    });
  }
  if (hasBun) await command("bun", ["smoke.mjs"], { cwd: consumer });

  await writeFile(
    join(consumer, "native.mjs"),
    undent`
    import { mkdtemp, rm } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    import { createFileSystem } from '@okikio/opfs';
    ${finish.toString()}
    const failures = [], releases = [];
    const runtime = typeof Bun !== 'undefined' ? 'bun' : typeof Deno !== 'undefined' ? 'deno' : 'node';
    try {
    const module = await import('@okikio/opfs/adapter/' + runtime);
    const root = await mkdtemp(fileURLToPath(new URL('./opfs-packed-native-', import.meta.url)));
    releases.push(() => rm(root, { recursive: true, force: true }));
    const adapter = module[runtime === 'bun' ? 'createBunAdapter' : runtime === 'deno' ? 'createDenoAdapter' : 'createNodeAdapter']({ root });
    const fs = createFileSystem(adapter, { coordination: 'local' });
    releases.push(() => fs.close());
      await fs.writeFile('/data.txt', '0123456789');
      await fs.writeFile('/data.txt', 'AB', { mode: 'update', at: 3 });
      if (await fs.readText('/data.txt') !== '012AB56789') throw new Error(runtime + ' update mismatch');
      await fs.copy('/data.txt', '/copy.txt');
      await fs.move('/copy.txt', '/moved.txt');
      if (await fs.readText('/moved.txt') !== '012AB56789') throw new Error(runtime + ' move mismatch');
      if (await fs.exists('/copy.txt')) throw new Error(runtime + ' move retained source');
    } catch (reason) { failures.push(reason); }
    finally { await finish(releases, failures); }
    console.log('Packed ' + runtime + ' native workflow passed');
  `,
  );
  await command("node", ["native.mjs"], { cwd: consumer });
  await command("deno", [
    "run",
    "--no-config",
    "--allow-read",
    "--allow-write",
    "--allow-env=TMPDIR,TMP,TEMP",
    "--node-modules-dir=manual",
    "native.mjs",
  ], {
    cwd: consumer,
  });
  await command("bun", ["native.mjs"], { cwd: consumer });

  await writeFile(
    join(consumer, "consumer.ts"),
    undent`
    import { createFileSystem, type FileSystemType } from '@okikio/opfs';
    import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
    const fileSystem: FileSystemType = createFileSystem(createMemoryAdapter());
    await fileSystem.writeFile('/types.txt', 'ok', { parents: true });
`,
  );
  if (hasDeno) {
    await command(
      "deno",
      ["check", "--no-config", "--node-modules-dir=manual", "consumer.ts"],
      { cwd: consumer },
    );
  }

  // Compiler and Node declarations are fixture tooling, never package runtime dependencies.
  await command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "typescript@7.0.2",
    "typescript59@npm:typescript@5.9.3",
    "@types/node@26.2.0",
  ], { cwd: consumer });
  await writeFile(
    join(consumer, "portable-types.ts"),
    undent`
    import { createFileSystem, type FileSystemType } from '@okikio/opfs';
    import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
    import { createTarStream, readTarStream } from '@okikio/opfs/archive/stream';
    import type { TarWriteEntryType } from '@okikio/opfs/archive/stream';
    import { openTar } from '@okikio/opfs/archive/tar';
    import { createTarAdapter } from '@okikio/opfs/view/tar';
    import { openCpio } from '@okikio/opfs/archive/cpio';
    import { createCpioAdapter } from '@okikio/opfs/view/cpio';
    import { DriveClient } from '@okikio/opfs/drive';
    import { OnedriveClient } from '@okikio/opfs/onedrive';
    import { OciClient } from '@okikio/opfs/oci';
    import { openCab } from '@okikio/opfs/archive/cab';
    import { openWarc } from '@okikio/opfs/archive/warc';
    import { openMime } from '@okikio/opfs/archive/mime';
    import { openSeven } from '@okikio/opfs/archive/seven';
    import { openAr } from '@okikio/opfs/archive/ar';
    import { openMbox } from '@okikio/opfs/archive/mbox';
    import { FtpClient } from '@okikio/opfs/ftp';
    import { createD1Adapter } from '@okikio/opfs/adapter/d1';
    import { createZipStream } from '@okikio/opfs/archive/write';
    import type { ZipWriteEntryType } from '@okikio/opfs/archive/write';
    import { openZip } from '@okikio/opfs/archive/zip';
    import { createByteSource } from '@okikio/opfs/source';
    import { createCompressedTar, readCompressedTar } from '@okikio/opfs/archive/compress';
    import { parseCid, verifyBlock } from '@okikio/opfs/content/cid';
    import { S3SessionSchema } from '@okikio/opfs/transfer/s3';
    import type { S3SessionType } from '@okikio/opfs/transfer/s3';
    import { AzureSessionSchema } from '@okikio/opfs/transfer/azure';
    import type { AzureSessionType } from '@okikio/opfs/transfer/azure';
    import type { D1BindingType } from '@okikio/opfs/driver/d1';
    declare const binding: D1BindingType;
    const d1: FileSystemType = createFileSystem(await createD1Adapter(binding));
    const drive = new DriveClient({ token: () => 'type-only' });
    const driveFile: string = (await drive.stat('file')).id;
    const tarView = createTarAdapter(await openTar(createByteSource(new Uint8Array())));
    const cpioView = createCpioAdapter(await openCpio(createByteSource(new Uint8Array())));
    void [d1, driveFile, tarView, cpioView];
    const onedrive = new OnedriveClient({ driveId: 'typed', token: () => 'type-only' });
    const cab = await openCab(createByteSource(new Uint8Array()));
    const warc = await openWarc(createByteSource(new Uint8Array()));
    const readable: boolean = warc.entries[0]!.readable;
    const mime = await openMime(createByteSource(new Uint8Array()));
    const mimeComplete: boolean = (await mime.prefix(0, 1)).complete;
    const seven = await openSeven(createByteSource(new Uint8Array()));
    const sevenReadable: boolean = seven.entries[0]!.readable;
    const ar = await openAr(createByteSource(new Uint8Array()));
    const arSource = ar.member(0);
    const mbox = await openMbox(createByteSource(new Uint8Array()), { dialect: 'mboxrd' });
    const mboxSource = (await mbox.openMessage(0, { trailing: 'preserve' })).source;
    const ftp = new FtpClient({ host: 'types.invalid', username: 'user', password: 'password', mode: 'plain', transport: { async connect() { throw new Error('types only'); } } });
    const ftpDone: Promise<void> = ftp.close();
    void [onedrive, cab, readable, mimeComplete, sevenReadable, arSource, mboxSource, ftpDone];
    const registry = new OciClient({ registry: 'https://registry.invalid/', repository: 'types/content' });
    const ociDigest: string = (await registry.getManifest('release')).digest;
    void ociDigest;
    const fileSystem: FileSystemType = createFileSystem(createMemoryAdapter());
    await fileSystem.writeFile('/types.txt', 'ok', { parents: true });
    const tarEntry: TarWriteEntryType = { name: 'typed', size: 0 };
    await readTarStream(createTarStream([tarEntry]), async (entry, body) => {
      const id: number = entry.id;
      for await (const bytes of body) { const size: number = bytes.byteLength; void size; }
      void id;
    });
    const zipEntry: ZipWriteEntryType = { name: 'typed', size: 0 };
    const zipBytes = new Uint8Array(await new Response(createZipStream([zipEntry])).arrayBuffer());
    const zip = await openZip(createByteSource(zipBytes));
    const member: Uint8Array = (await zip.read(0)).bytes;
    void member;
    const compressedTar = createCompressedTar([{ name: 'typed', size: 0 }], 'gzip');
    const result = await readCompressedTar(compressedTar, 'gzip', () => {});
    const integrity: string = result.compression.integrity;
    const cid = parseCid('f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    await verifyBlock(cid.id, new TextEncoder().encode('hello'));
    const s3: S3SessionType = S3SessionSchema.parse({});
    const azure: AzureSessionType = AzureSessionSchema.parse({});
    void [integrity, s3, azure];
    // @ts-expect-error Portable root declarations must not load the native Deno namespace.
    void Deno;
  `,
  );
  await writeFile(
    join(consumer, "node-types.ts"),
    undent`
    import { createFileSystem } from '@okikio/opfs';
    import { createNodeAdapter } from '@okikio/opfs/adapter/node';
    import type { NodeFsPromisesType } from '@okikio/opfs/driver/node';
    import type { FileHandle } from 'node:fs/promises';
    const fileSystem = createFileSystem(createNodeAdapter({ root: '/type-only' }));
    declare const host: NodeFsPromisesType;
    const file: FileHandle = await host.open('/type-only/input', 'r');
    // @ts-expect-error Node declarations must not load the native Deno namespace.
    void Deno;
    void fileSystem; void file;
  `,
  );
  await writeFile(
    join(consumer, "native-types.ts"),
    undent`
    import { DenoRangeSource, writeStreamToFile } from '@okikio/opfs/driver/deno';
    import { createDenoAdapter } from '@okikio/opfs/adapter/deno';
    declare const file: Deno.FsFile;
    const accepted: Parameters<typeof writeStreamToFile>[0] = file;
    const range = new DenoRangeSource(accepted, 4);
    const adapter = createDenoAdapter({ root: '/type-only' });
    // @ts-expect-error The native leaf retains the real FsFile contract.
    new DenoRangeSource({ read: async () => null }, 4);
    void range; void adapter;
  `,
  );
  await writeFile(
    join(consumer, "typecheck.mjs"),
    undent`
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { dirname, resolve } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const compiler = process.argv[4] ?? 'typescript';
    const manifestPath = fileURLToPath(import.meta.resolve(compiler + '/package.json'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.version, compiler === 'typescript' ? '7.0.2' : '5.9.3');
    assert.equal(typeof manifest.bin?.tsc, 'string', 'Compiler must publish its real tsc binary');
    const cli = resolve(dirname(manifestPath), manifest.bin.tsc);
    const entry = process.argv[2];
    const native = entry === 'native-types.ts';
    const node = entry === 'node-types.ts';
    const discovery = process.argv[3] === 'default';
    writeFileSync('tsconfig.artifact.json', JSON.stringify({
      compilerOptions: {
        target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext',
        lib: ['ESNext', 'DOM', 'DOM.Iterable'],
        ...(node ? { types: ['node'] } : discovery ? {} : { types: [] }), strict: true, noEmit: true, skipLibCheck: false,
      },
      files: [entry],
    }));
    // --listFiles retains semantic checking; --listFilesOnly would bypass it.
    const result = spawnSync(process.execPath, [cli, '--project', 'tsconfig.artifact.json', '--listFiles', '--pretty', 'false'], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(result.stdout); console.error(result.stderr);
      throw new Error('Installed compiler rejected artifact declarations', { cause: { status: result.status, signal: result.signal } });
    }
    const sources = result.stdout.split(String.fromCharCode(10)).map(file => file.trim())
      .filter(file => file.endsWith('.ts')).map(file => file.replaceAll(String.fromCharCode(92), '/'));
    assert.ok(sources.length > 0, 'Compiler must report its checked declaration graph');
    const deno = sources.some(file => file.includes('/node_modules/deno-types/'));
    assert.equal(deno, native, 'Only the native Deno leaf may load its aliased namespace');
    assert.equal(sources.some(file => file.includes('/node_modules/@types/deno/')), false,
      'Build-only Deno declarations must not reach the installed consumer');
    const nodeTypes = sources.some(file => file.includes('/node_modules/@types/node/'));
    if (node) assert.ok(nodeTypes, 'The native Node leaf must use the actual selected Node host declarations');
    if (entry === 'portable-types.ts' && (!discovery || compiler === 'typescript')) {
      assert.equal(nodeTypes, false, 'Portable root requires no Node declarations');
    }
    console.log(JSON.stringify({ entry, compiler: manifest.version, types: node ? ['node'] : discovery ? 'default' : [], strict: true,
      skipLibCheck: false, deno, checkedFiles: sources.length, checker: 'published tsc CLI --listFiles' }));
  `,
  );
  for (const compiler of ["typescript", "typescript59"]) {
    await command("node", ["typecheck.mjs", "node-types.ts", "node", compiler], { cwd: consumer });
    for (const discovery of ["default", "explicit"]) {
      await command("node", [
        "typecheck.mjs",
        "portable-types.ts",
        discovery,
        compiler,
      ], { cwd: consumer });
      await command("node", [
        "typecheck.mjs",
        "native-types.ts",
        discovery,
        compiler,
      ], { cwd: consumer });
    }
  }

  await writeFile(
    join(consumer, "browser.mjs"),
    undent`
    import { createFileSystem } from '@okikio/opfs';
    import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
    import { normalizePath } from '@okikio/opfs/path';
    export const smoke = () => [createFileSystem(createMemoryAdapter()), normalizePath('a/../b')];
`,
  );
  if (hasDeno) {
    await command("deno", [
      "bundle",
      "--no-config",
      "--platform=browser",
      "--node-modules-dir=manual",
      "--output",
      "browser-bundle.js",
      "browser.mjs",
    ], { cwd: consumer });
  }

  await command(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "drizzle-orm@0.45.2",
    ],
    { cwd: consumer },
  );
  await writeFile(
    join(consumer, "drizzle.mjs"),
    `await import('@okikio/opfs/adapter/drizzle');\n`,
  );
  await command("node", ["drizzle.mjs"], { cwd: consumer });
  if (hasDeno) {
    await command("deno", [
      "run",
      "--no-config",
      "--node-modules-dir=manual",
      "drizzle.mjs",
    ], {
      cwd: consumer,
    });
  }
  if (hasBun) await command("bun", ["drizzle.mjs"], { cwd: consumer });

  const specs = Object.keys(manifest.exports).map((key) =>
    key === "." ? "@okikio/opfs" : `@okikio/opfs/${key.slice(2)}`
  );
  await writeFile(
    join(consumer, "exports.mjs"),
    undent`
    import { realpath } from 'node:fs/promises';
    import { dirname, isAbsolute, join, relative, sep } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const consumer = await realpath(dirname(fileURLToPath(import.meta.url)));
    const root = await realpath(join(consumer, 'node_modules/@okikio/opfs'));
    if (relative(consumer, root) !== join('node_modules', '@okikio', 'opfs')) {
      throw new Error('Package root is outside the fresh installed consumer: ' + root);
    }
    for (const spec of ${JSON.stringify(specs)}) {
      const path = await realpath(fileURLToPath(import.meta.resolve(spec)));
      const inside = relative(root, path);
      if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
        throw new Error(spec + ' resolved outside the installed package: ' + path);
      }
      await import(spec);
    }
    console.log('Imported ${specs.length} physically installed packed public entrypoints');
`,
  );
  await command("node", ["exports.mjs"], { cwd: consumer });
  await command("deno", [
    "run",
    "--no-config",
    "--allow-read",
    "--node-modules-dir=manual",
    "exports.mjs",
  ], {
    cwd: consumer,
  });
  await command("bun", ["exports.mjs"], { cwd: consumer });
} catch (reason) {
  failures.push(reason);
} finally {
  await finish(
    [() => rm(workspace, { recursive: true, force: true })],
    failures,
  );
}
