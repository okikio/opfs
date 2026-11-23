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
    import { SftpClient } from '@okikio/opfs/sftp';
    import { openBagit } from '@okikio/opfs/archive/bagit';
    import { openOcfl } from '@okikio/opfs/archive/ocfl';
    import { DropboxClient, contentHash as dropboxContentHash } from '@okikio/opfs/dropbox';
    import { BoxClient } from '@okikio/opfs/box';
    import { createLz4Decoder } from '@okikio/opfs/archive/lz4';
    import { openArc } from '@okikio/opfs/archive/arc';
    import { openIso } from '@okikio/opfs/archive/iso';
    import { openXar } from '@okikio/opfs/archive/xar';
    import { openWim } from '@okikio/opfs/archive/wim';
    import { createLzmaDecoder } from '@okikio/opfs/archive/lzma';
    import { PcloudClient } from '@okikio/opfs/pcloud';
    import { YandexClient } from '@okikio/opfs/yandex';
    import { FirebaseClient } from '@okikio/opfs/firebase';
    import { openUdf } from '@okikio/opfs/archive/udf';
    import { createBzipDecoder } from '@okikio/opfs/archive/bzip';
    import { PocketbaseClient } from '@okikio/opfs/pocketbase';
    import { SupabaseClient } from '@okikio/opfs/supabase';
    import { NextcloudClient } from '@okikio/opfs/nextcloud';
    import { ResticClient } from '@okikio/opfs/restic';
    import { LakefsClient } from '@okikio/opfs/lakefs';
    import { createGcsClient, GcsStorageClassSchema } from '@okikio/opfs/gcs';
    import { openFits } from '@okikio/opfs/dataset/fits';
    import { openNetcdf } from '@okikio/opfs/dataset/netcdf';
    import { openZarr, createZarrObjectLedger } from '@okikio/opfs/dataset/zarr';
    import { openLas } from '@okikio/opfs/dataset/las';
    import { openArfs } from '@okikio/opfs/content/arfs';
    import { SeafileClient } from '@okikio/opfs/seafile';
    import { openUnixfs } from '@okikio/opfs/content/unixfs';
    import { openRar } from '@okikio/opfs/archive/rar';
    import { openXz } from '@okikio/opfs/archive/xz';
    import { LfsClient, decodeLfsPointer, encodeLfsPointer, lfsPointerObject } from '@okikio/opfs/content/lfs';
    import { openGitObject, encodeGitTree } from '@okikio/opfs/content/git';
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
    const mszipFixture = ${
      JSON.stringify(
        await (async () => {
          return JSON.parse(await readFile(new URL("../fixtures/cab/mszip.json", import.meta.url), "utf8")).vectors
            .find((entry) => entry.name === "dynamic-history");
        })(),
      )
    };
    const mszip = await openCab(createByteSource(Uint8Array.from(atob(mszipFixture.archive), (byte) => byte.charCodeAt(0))));
    const mszipRead = await mszip.read(0, { offset: 32768, length: 3 });
    assertBytes(mszipRead.bytes, Uint8Array.from(atob(mszipFixture.body), (byte) => byte.charCodeAt(0)).subarray(32768, 32771));
    if (!mszipRead.blocks.some((block) => block.role === 'history') || mszipRead.integrity !== 'block-checksum-verified') throw new Error('Packed MSZIP prerequisite evidence changed');
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
    const compressedSevenFixtures = ${
      JSON.stringify(
        await (async () => {
          const fixtures = JSON.parse(
            await readFile(new URL("../fixtures/seven/independent.json", import.meta.url), "utf8"),
          );
          return [fixtures["encoded-lzma1"], fixtures.lzma2];
        })(),
      )
    };
    for (const fixture of compressedSevenFixtures) {
      const compressedSeven = await openSeven(createByteSource(Uint8Array.from(atob(fixture.archive), (byte) => byte.charCodeAt(0))));
      for (const entry of compressedSeven.entries.filter((entry) => entry.kind === 'file' && entry.size > 0)) {
        const result = await compressedSeven.read(entry.id);
        assertBytes(result.bytes, Uint8Array.from(atob(fixture.entries.find((item) => item.name === entry.name).body), (byte) => byte.charCodeAt(0)));
        if (result.decoding !== 'complete' || result.integrity !== 'crc32-verified') throw new Error('Packed 7z compressed member scope changed');
      }
      if (fixture.nextHeaderTag === 23 && compressedSeven.headers.decoded?.integrity !== 'crc32-verified') throw new Error('Packed 7z encoded metadata was not verified');
    }
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
    const bagitFixture = ${
      JSON.stringify(JSON.parse(await readFile(new URL("../fixtures/bagit/independent.json", import.meta.url), "utf8")))
    };
    const bag = await openBagit([{ kind: 'directory', path: 'data' }, ...bagitFixture.files.map((entry) => ({ kind: 'file', path: entry.path, source: createByteSource(Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))) }))]);
    if (bag.coverage.issues.length) throw new Error('Packed BagIt coverage differs from independent inventory');
    const bagManifest = bag.manifests.find((manifest) => manifest.kind === 'payload' && manifest.algorithm === 'sha512');
    if ((await bag.verify(bagManifest.id, 'data/binary.bin', { subtle: globalThis.crypto.subtle })).integrity !== 'manifest-digest') throw new Error('Packed BagIt digest failed');
    assertBytes(await bag.source('data/binary.bin').read(0, 5), new Uint8Array([0,1,2,3,255]));
    const passwordFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/password/independent.json", import.meta.url), "utf8")).stored,
      )
    };
    const passwordZip = await openZip(createByteSource(Uint8Array.from(atob(passwordFixture.archive), (byte) => byte.charCodeAt(0))));
    const passwordEntry = passwordZip.entries.find((entry) => entry.name === 'first.bin');
    const passwordRead = await passwordZip.read(passwordEntry.id, { password: Uint8Array.from(atob(passwordFixture.password), (byte) => byte.charCodeAt(0)) });
    assertBytes(passwordRead.bytes, Uint8Array.from(atob(passwordFixture.entries.find((entry) => entry.name === 'first.bin').body), (byte) => byte.charCodeAt(0)));
    if (passwordRead.encryption.authentication !== 'none' || passwordRead.integrity !== 'checksum-verified') throw new Error('Packed ZipCrypto evidence changed');
    const sftp = new SftpClient({ openChannel() { throw new Error('SFTP construction acquired a channel'); } });
    await sftp.close();
    const ocflFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/ocfl/independent.json", import.meta.url), "utf8")).objects[0],
      )
    };
    const ocfl = await openOcfl(ocflFixture.files.map((entry) => ({ path: entry.path, source: createByteSource(Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))) })));
    if ((await ocfl.verifyInventory({ subtle: globalThis.crypto.subtle })).scope !== 'inventory-digest') throw new Error('Packed OCFL inventory proof changed');
    if ((await ocfl.verifyContent('v1', 'binary', { subtle: globalThis.crypto.subtle })).scope !== 'selected-content') throw new Error('Packed OCFL content proof changed');
    const aesFixtures = ${
      JSON.stringify(
        await (async () => {
          const fixtures = JSON.parse(
            await readFile(new URL("../fixtures/aes/independent.json", import.meta.url), "utf8"),
          );
          return [fixtures["aes256-ae2"], fixtures.deflate, fixtures["deflate-ae1"]];
        })(),
      )
    };
    for (const aesFixture of aesFixtures) {
    const aesZip = await openZip(createByteSource(Uint8Array.from(atob(aesFixture.archive), (byte) => byte.charCodeAt(0))));
    const aesEntry = aesZip.entries.find((entry) => entry.name === aesFixture.entries[0].name);
    const aesRead = await aesZip.read(aesEntry.id, { verify: true, password: Uint8Array.from(atob(aesFixture.password), (byte) => byte.charCodeAt(0)), aes: { subtle: globalThis.crypto.subtle } });
    assertBytes(aesRead.bytes, Uint8Array.from(atob(aesFixture.entries[0].body), (byte) => byte.charCodeAt(0)));
    if (aesRead.integrity !== (aesEntry.aes.version === 1 ? 'checksum-verified' : 'not-provided') || aesRead.encryption.authentication !== 'ciphertext-verified') throw new Error('Packed AES scope changed');
    const aesPlan = aesZip.plan(aesEntry.id, { verify: true, password: Uint8Array.from(atob(aesFixture.password), (byte) => byte.charCodeAt(0)), aes: { subtle: globalThis.crypto.subtle } });
    if (aesEntry.aes.method === 8 && aesEntry.aes.version === 2 && aesPlan.verification !== 'full-member-decode') throw new Error('Packed AES DEFLATE plan scope changed');
    }
    const dropbox = new DropboxClient({ token: () => 'fixture-token', fetch: async () => new Response(JSON.stringify({'.tag':'file',name:'packed',id:'id:packed',rev:'012345678',size:3}), {headers:{'Content-Type':'application/json'}}) });
    if ((await dropbox.stat('id:packed')).id !== 'id:packed') throw new Error('Packed Dropbox native metadata failed');
    if (await dropboxContentHash(new Uint8Array(), { subtle: globalThis.crypto.subtle }) !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') throw new Error('Packed Dropbox empty hash failed');
    const nativeCodecs = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/compression/native.json", import.meta.url), "utf8")),
      )
    };
    for (const format of ['brotli', 'zstd']) {
      let decoded;
      try { decoded = decompressStream(new Blob([Uint8Array.from(atob(nativeCodecs.formats[format].bytes), (byte) => byte.charCodeAt(0))]).stream(), format); }
      catch (reason) { if (reason.code !== 'unsupported-profile') throw reason; continue; }
      assertBytes(new Uint8Array(await new Response(decoded).arrayBuffer()), Uint8Array.from(atob(nativeCodecs.payload), (byte) => byte.charCodeAt(0)));
    }
    const lz4Fixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/lz4/independent.json", import.meta.url), "utf8"))
          .frames["no-checksum"],
      )
    };
    const lz4 = createLz4Decoder(new Blob([Uint8Array.from(atob(lz4Fixture.archive), (byte) => byte.charCodeAt(0))]).stream());
    assertBytes(new Uint8Array(await new Response(lz4.stream).arrayBuffer()), Uint8Array.from(atob(lz4Fixture.body), (byte) => byte.charCodeAt(0)));
    if ((await lz4.finished).status !== 'complete') throw new Error('Packed LZ4 completion failed');
    const box = new BoxClient({ token: () => 'fixture-token', fetch: async () => new Response(JSON.stringify({type:'file',name:'packed',id:'1',file_version:{id:'2'},size:3}), {headers:{'Content-Type':'application/json'}}) });
    if ((await box.statFile('1')).versionId !== '2') throw new Error('Packed Box version metadata failed');
    const arcFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/arc/independent.json", import.meta.url), "utf8")).objects[0],
      )
    };
    const arc = await openArc(createByteSource(Uint8Array.from(atob(arcFixture.base64), (byte) => byte.charCodeAt(0))));
    const arcBlock = await arc.read(1);
    if (arcBlock.integrity !== 'none' || !new TextDecoder().decode(arcBlock.bytes).startsWith('HTTP/1.1 200 OK')) throw new Error('Packed ARC stored block changed');
    const gitFixture = ${
      JSON.stringify(
        await (async () => {
          const manifest = JSON.parse(
            await readFile(new URL("../fixtures/git/manifest.json", import.meta.url), "utf8"),
          );
          const record = manifest.objects.find((entry) => entry.algorithm === "sha256" && entry.label === "blob");
          return {
            oid: record.oid,
            loose: (await readFile(new URL("../fixtures/git/" + record.loose, import.meta.url))).toString("base64"),
            payload: (await readFile(new URL("../fixtures/git/" + record.payload, import.meta.url))).toString("base64"),
          };
        })(),
      )
    };
    const git = await openGitObject(createByteSource(Uint8Array.from(atob(gitFixture.loose), (byte) => byte.charCodeAt(0))), { algorithm: 'sha256', oid: gitFixture.oid, subtle: globalThis.crypto.subtle });
    assertBytes(await git.read(), Uint8Array.from(atob(gitFixture.payload), (byte) => byte.charCodeAt(0)));
    if (encodeGitTree([], { algorithm: 'sha256' }).length !== 0) throw new Error('Packed empty Git tree failed');
    const firebase = new FirebaseClient({ bucket: 'demo-opfs.appspot.com', credentials: () => ({ idToken: 'fixture-token' }), fetch: async (_input, init) => {
      if (new Headers(init.headers).get('Authorization') !== 'Firebase fixture-token') throw new Error('Packed Firebase credential scheme changed');
      return Response.json({ bucket: 'demo-opfs.appspot.com', name: 'packed', size: '3', generation: '9007199254740993', metageneration: '1' });
    } });
    if ((await firebase.stat('packed')).generation !== '9007199254740993') throw new Error('Packed Firebase generation was rounded');
    const xzFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/xz/independent.json", import.meta.url), "utf8")).cases.find((
          entry,
        ) => entry.name === "crc64-vector"),
      )
    };
    const xz = await openXz(createByteSource(Uint8Array.from(atob(xzFixture.archive), (byte) => byte.charCodeAt(0))));
    const xzRead = await xz.read();
    assertBytes(xzRead.bytes, Uint8Array.from(atob(xzFixture.body), (byte) => byte.charCodeAt(0)));
    if (xz.check !== 'crc64' || xzRead.checks[0].integrity !== 'crc64-verified' || xzRead.checks[0].crc64 !== '995dc9bbdf1939fa') throw new Error('Packed XZ CRC64 evidence changed');
    const lfsPointerBytes = Uint8Array.from(atob(${
      JSON.stringify((await readFile(new URL("../fixtures/lfs/hello.pointer", import.meta.url))).toString("base64"))
    }), (byte) => byte.charCodeAt(0));
    const lfsPointer = decodeLfsPointer(lfsPointerBytes);
    assertBytes(encodeLfsPointer(lfsPointer), lfsPointerBytes);
    const lfsObject = lfsPointerObject(lfsPointer);
    const lfs = new LfsClient({ endpoint: 'https://repo.example/lfs/', downloadOrigins: ['https://objects.example'], subtle: globalThis.crypto.subtle, credentials: () => ({ Authorization: 'Bearer repository-only' }), fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://repo.example') {
        if (new Headers(init.headers).get('Authorization') !== 'Bearer repository-only') throw new Error('Packed LFS repository auth changed');
        return Response.json({ objects: [{ ...lfsObject, actions: { download: { href: 'https://objects.example/body' } } }] });
      }
      if (new Headers(init.headers).has('Authorization')) throw new Error('Packed LFS leaked repository auth');
      return new Response('hello\\n');
    } });
    const lfsSource = await lfs.openVerified(lfsObject);
    assertBytes(await lfsSource.read(1, 3), new TextEncoder().encode('ell'));
    const bzipFixture = ${
      JSON.stringify(
        JSON.parse(await readFile(new URL("../fixtures/bzip/independent.json", import.meta.url), "utf8")).fixtures.find(
          (entry) => entry.name === "binary",
        ),
      )
    };
    const bzip = createBzipDecoder(createByteSource(Uint8Array.from(atob(bzipFixture.packed), (byte) => byte.charCodeAt(0))));
    const [bzipBody, bzipEnd] = await Promise.all([new Response(bzip.stream).arrayBuffer(), bzip.finished]);
    assertBytes(new Uint8Array(bzipBody), Uint8Array.from(atob(bzipFixture.body), (byte) => byte.charCodeAt(0)));
    if (bzipEnd.status !== 'complete' || bzipEnd.integrity !== 'checksum-verified') throw new Error('Packed BZip2 terminal scope changed');
    const pocketbase = new PocketbaseClient({ endpoint: 'https://pocket.example/', collection: 'documents', field: 'files', credentials: () => 'Bearer repository-token', fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/api/files/documents/')) {
        if (new Headers(init.headers).has('Authorization') || url.searchParams.get('token') !== 'explicit-file-token') throw new Error('Packed PocketBase file authority changed');
        return new Response(new TextEncoder().encode('hello'), { headers: { 'Content-Length': '5' } });
      }
      if (new Headers(init.headers).get('Authorization') !== 'Bearer repository-token') throw new Error('Packed PocketBase API header changed');
      if (url.pathname === '/api/files/token') return Response.json({ token: 'explicit-file-token' });
      return Response.json({ id: 'record000000001', collectionId: 'documents', collectionName: 'documents', files: ['hello.txt'] });
    } });
    const pocketRecord = await pocketbase.getRecord('record000000001');
    const pocketToken = await pocketbase.fileToken();
    assertBytes(await pocketbase.read(pocketRecord.id, pocketRecord.files[0], { token: pocketToken }), new TextEncoder().encode('hello'));
    const udfFixture = ${
      JSON.stringify(
        await (async () => {
          const value = JSON.parse(
            await readFile(new URL("../fixtures/udf/independent.json", import.meta.url), "utf8"),
          );
          const original = value.entries.find((entry) => entry.name === "large.bin");
          return {
            archive: value.adaptations.find((entry) => entry.name === "split-long").archive,
            body: original.body,
          };
        })(),
      )
    };
    const udf = await openUdf(createByteSource(Uint8Array.from(atob(udfFixture.archive), (byte) => byte.charCodeAt(0))));
    const udfEntry = udf.entries.find((entry) => entry.kind === 'file' && entry.name === 'large.bin');
    const udfOriginal = Uint8Array.from(atob(udfFixture.body), (byte) => byte.charCodeAt(0));
    assertBytes((await udf.read(udfEntry.id)).bytes, udfOriginal);
    assertBytes(await udf.member(udfEntry.id).read(2040, 37), udfOriginal.slice(2040, 2077));
    if (udf.metadata !== 'descriptor-crc16-verified' || (await udf.read(udfEntry.id, { length: 0 })).integrity !== 'none') throw new Error('Packed UDF metadata/payload scope changed');
    const yandex = new YandexClient({ token: () => 'fixture-token', fetch: async () => Response.json({ path: 'disk:/packed', name: 'packed', type: 'file', size: 3 }) });
    if ((await yandex.stat('disk:/packed')).size !== 3) throw new Error('Packed Yandex native resource failed');
    const pcloud = new PcloudClient({ endpoint: 'https://api.pcloud.com', token: () => 'fixture-token', fetch: async () => new Response('{"result":0,"metadata":{"isfolder":false,"id":"f7","fileid":7,"parentfolderid":0,"name":"packed","size":3,"hash":18446744073709551615}}') });
    if ((await pcloud.statFile('7')).hash !== '18446744073709551615') throw new Error('Packed pCloud uint64 was rounded');
    const isoFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture =
            JSON.parse(await readFile(new URL("../fixtures/iso/independent.json", import.meta.url), "utf8"))
              .images["genisoimage-joliet"];
          return {
            archive: fixture.archive,
            body: fixture.profiles.joliet.find((entry) => entry.name === "/hello.txt").body,
          };
        })(),
      )
    };
    const iso = await openIso(createByteSource(Uint8Array.from(atob(isoFixture.archive), (byte) => byte.charCodeAt(0))), { namespace: 'joliet' });
    const isoHello = iso.entries.find((entry) => entry.parentId === -1 && entry.name === 'hello.txt');
    assertBytes((await iso.read(isoHello.id)).bytes, Uint8Array.from(atob(isoFixture.body), (byte) => byte.charCodeAt(0)));
    const lzmaFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/lzma/independent.json", import.meta.url), "utf8"),
          ).cases.find((entry) => entry.name === "lzma2-literal");
          return { packed: fixture.packed, body: fixture.body, dictionary: fixture.dictionary };
        })(),
      )
    };
    const lzma = createLzmaDecoder(createByteSource(Uint8Array.from(atob(lzmaFixture.packed), (byte) => byte.charCodeAt(0))), { format: 'raw-lzma2', dictionary: lzmaFixture.dictionary });
    const lzmaChunks = [];
    for await (const bytes of lzma.stream) lzmaChunks.push(...bytes);
    assertBytes(Uint8Array.from(lzmaChunks), Uint8Array.from(atob(lzmaFixture.body), (byte) => byte.charCodeAt(0)));
    const lzmaEnd = await lzma.finished;
    if (lzmaEnd.status !== 'complete' || lzmaEnd.termination !== 'lzma2-end' || lzmaEnd.integrity !== 'none') throw new Error('Packed LZMA terminal scope changed');
    let gcsArchiveCalls = 0;
    const gcsArchive = createGcsClient({
      bucket: 'installed-bucket', endpoint: 'https://storage.example', token: 'explicit-token',
      fetch: async (input, init) => {
        if (new Headers(init?.headers).get('authorization') !== 'Bearer explicit-token') throw new Error('Packed GCS explicit authority changed');
        if (gcsArchiveCalls++ === 0) {
          if (JSON.parse(String(init?.body)).storageClass !== 'ARCHIVE') throw new Error('Packed GCS class intent lost');
          return new Response(null, { headers: { location: 'https://storage.example/upload?upload_id=installed-session' } });
        }
        assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), new Uint8Array([1, 2, 3]));
        return Response.json({ name: 'archive.bin', size: '3', generation: '18446744073709551614', storageClass: 'ARCHIVE' });
      },
    });
    const gcsArchiveReceipt = await gcsArchive.put('archive.bin', new Uint8Array([1, 2, 3]), { storageClass: GcsStorageClassSchema.parse('ARCHIVE') });
    if (gcsArchiveReceipt.storageClass !== 'ARCHIVE' || gcsArchiveReceipt.revision.value !== '18446744073709551614') throw new Error('Packed GCS class/generation receipt changed');
    const lakefs = new LakefsClient({
      endpoint: 'https://lake.example/', repository: 'installed', credentials: () => 'Bearer explicit-lake-token',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (new Headers(init?.headers).get('authorization') !== 'Bearer explicit-lake-token') throw new Error('Packed lakeFS authority changed');
        if (url.pathname.endsWith('/branches/work/objects')) {
          if (new Headers(init?.headers).get('if-none-match') !== '*' || url.searchParams.get('path') !== 'native.bin') throw new Error('Packed lakeFS staging intent changed');
          assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), new Uint8Array([1, 2, 3]));
          return Response.json({ path: 'native.bin', path_type: 'object', size_bytes: 3, checksum: 'native-metadata-only' }, { status: 201 });
        }
        if (url.pathname.endsWith('/branches/work/commits')) return Response.json({ id: 'opaque-commit', parents: ['old'], message: 'Publish staged file', committer: 'fixture', creation_date: 1 }, { status: 201 });
        if (!url.pathname.endsWith('/refs/opaque-commit/objects') || url.searchParams.get('presign') !== 'false') throw new Error('Packed lakeFS committed read changed');
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } });
      },
    });
    const lakefsStaged = await lakefs.put('work', 'native.bin', new Uint8Array([1, 2, 3]), { ifNoneMatch: '*' });
    if (lakefsStaged.size !== 3) throw new Error('Packed lakeFS staging receipt changed');
    const lakefsCommitted = await lakefs.commit('work', 'Publish staged file');
    if (lakefsCommitted.id !== 'opaque-commit' || lakefsCommitted.created !== 1000) throw new Error('Packed lakeFS commit scope changed');
    assertBytes(await lakefs.read(lakefsCommitted.id, 'native.bin'), new Uint8Array([1, 2, 3]));
    const resticBody = new TextEncoder().encode('abc');
    const resticId = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const restic = new ResticClient({
      endpoint: 'https://backup.invalid/repository/', subtle: globalThis.crypto.subtle,
      credentials: () => 'Bearer explicit-repository-token',
      fetch: async (input, init) => {
        const target = new URL(input.toString());
        if (new Headers(init?.headers).get('authorization') !== 'Bearer explicit-repository-token') throw new Error('Packed restic authority changed');
        if (target.pathname.endsWith('/data/')) return new Response(JSON.stringify([{ name: resticId, size: 3 }]), { headers: { 'content-type': 'application/vnd.x.restic.rest.v2' } });
        if (!target.pathname.endsWith('/data/' + resticId)) throw new Error('Packed restic hash-address route changed');
        if (init.method === 'POST') {
          assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), resticBody);
          return new Response(null, { status: 200 });
        }
        return new Response(resticBody.slice(), { headers: { 'content-length': '3' } });
      },
    });
    const resticSaved = await restic.save('data', resticBody);
    if (resticSaved.id !== resticId || (await restic.list('data'))[0].id !== resticId) throw new Error('Packed restic object evidence changed');
    assertBytes(await restic.readVerified({ kind: 'data', id: resticId }), resticBody);
    const unixfsFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/unixfs/independent.json", import.meta.url), "utf8"),
          );
          const profile = fixture.profiles[0];
          return {
            cid: profile.cid,
            blocks: profile.blocks,
            file: profile.files.find((entry) => entry.path === "nested/data.bin"),
          };
        })(),
      )
    };
    const unixfsBlocks = new Map(unixfsFixture.blocks.map((entry) => [entry.cid, Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))]));
    const unixfsRoot = await openUnixfs(unixfsFixture.cid, async (cid) => {
      const block = unixfsBlocks.get(cid);
      if (!block) throw new Error('Packed UnixFS selected block absent');
      return block;
    }, { subtle: globalThis.crypto.subtle });
    if (unixfsRoot.kind !== 'directory') throw new Error('Packed UnixFS root kind changed');
    const unixfsDirectory = await unixfsRoot.open('nested');
    if (unixfsDirectory.kind !== 'directory') throw new Error('Packed UnixFS nested directory changed');
    const unixfsFile = await unixfsDirectory.open('data.bin');
    if (unixfsFile.kind !== 'file') throw new Error('Packed UnixFS selected file changed');
    const unixfsOriginal = Uint8Array.from(atob(unixfsFixture.file.base64), (byte) => byte.charCodeAt(0));
    assertBytes((await unixfsFile.read()).bytes, unixfsOriginal);
    assertBytes(await unixfsFile.source().read(173, 257), unixfsOriginal.subarray(173, 430));
    if ((await unixfsFile.verify()).scope !== 'complete-file') throw new Error('Packed UnixFS verification scope changed');
    const netcdfFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/netcdf/independent.json", import.meta.url), "utf8"),
          );
          return fixture.fixtures.find((entry) =>
            entry.producer === "netCDF-C" && entry.profile === "mixed" && entry.version === 2
          ).file.base64;
        })(),
      )
    };
    const netcdf = await openNetcdf(createByteSource(Uint8Array.from(atob(netcdfFixture), (byte) => byte.charCodeAt(0))));
    const netcdfVariable = netcdf.variables.find((entry) => entry.name === 'records');
    if (!netcdfVariable || netcdf.version !== 2 || netcdf.deviations.length) throw new Error('Packed netCDF native profile changed');
    const netcdfRaw = await netcdf.read(netcdfVariable.id, { offset: 2, count: 5 });
    if (!(netcdfRaw.values instanceof Int16Array) || JSON.stringify(Array.from(netcdfRaw.values)) !== '[2,3,-777,5,6]' || JSON.stringify(Array.from(netcdfRaw.undefinedMask)) !== '[0,0,1,0,0]' || netcdfRaw.integrity !== 'not-provided') throw new Error('Packed netCDF raw record selection changed');
    const netcdfPhysical = await netcdf.read(netcdfVariable.id, { offset: 2, count: 5, scale: 'physical' });
    if (!(netcdfPhysical.values instanceof Float64Array) || JSON.stringify(Array.from(netcdfPhysical.values)) !== '[11,11.5,-378.5,12.5,13]') throw new Error('Packed netCDF physical scaling changed');
    const arfsFixture = ${
      JSON.stringify(JSON.parse(await readFile(new URL("../fixtures/arfs/independent.json", import.meta.url), "utf8")))
    };
    const arfsBytes = (value) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
    const arfsMetadata = (record) => ({ transactionId: record.transactionId, owner: record.owner, tags: record.tags, source: createByteSource(arfsBytes(record.bytesBase64), { identity: 'native-fixture:' + record.transactionId }) });
    const arfsInventory = { drive: arfsMetadata(arfsFixture.metadata.find((record) => record.label === 'drive')), entities: arfsFixture.metadata.filter((record) => record.label !== 'drive').map(arfsMetadata) };
    const arfs = await openArfs(arfsInventory);
    const arfsFile = arfs.file(arfsFixture.ids.file);
    const arfsData = { transactionId: arfsFixture.payload.transactionId, source: createByteSource(arfsBytes(arfsFixture.payload.bytesBase64), { identity: 'native-data-fixture' }) };
    const arfsSelected = await arfsFile.read(arfsData, { offset: 6, length: 11 });
    assertBytes(arfsSelected.bytes, arfsBytes(arfsFixture.original.range.bytesBase64));
    assertBytes(await arfsFile.source(arfsData).read(0, arfsFile.size), arfsBytes(arfsFixture.original.bytesBase64));
    if (arfs.scope !== 'supplied-selected-revisions' || arfs.integrity !== 'caller-supplied-metadata' || arfsSelected.integrity !== 'caller-supplied-data' || arfs.list(arfsFixture.ids.root).entries.length !== 2) throw new Error('Packed ArFS supplied-inventory evidence changed');
    // An authored metadata revision explicitly binds independent Python ZIP bytes.
    const arfsZip = ${
      JSON.stringify(JSON.parse(await readFile(new URL("../fixtures/arfs/zip.json", import.meta.url), "utf8")))
    };
    const arfsZipBytes = arfsBytes(arfsZip.wireBase64), arfsZipTx = 'D'.repeat(42) + 'A';
    const arfsZipRecord = arfsFixture.metadata.find((record) => record.label === 'file');
    const arfsZipJson = { ...arfsZipRecord.expected, size: arfsZipBytes.length, dataTxId: arfsZipTx };
    const arfsZipMetadata = { ...arfsMetadata(arfsZipRecord), transactionId: 'C'.repeat(42) + 'A', source: createByteSource(new TextEncoder().encode(JSON.stringify(arfsZipJson)), { identity: 'authored-zip-metadata' }) };
    const arfsZipView = await openArfs({ drive: arfsInventory.drive, entities: [...arfsInventory.entities.filter((record) => record.transactionId !== arfsZipRecord.transactionId), arfsZipMetadata] });
    const arfsZipSource = arfsZipView.file(arfsFixture.ids.file).source({ transactionId: arfsZipTx, source: createByteSource(arfsZipBytes, { identity: 'independent-python-zip' }) });
    const arfsArchive = await openZip(arfsZipSource);
    assertBytes((await arfsArchive.read(0)).bytes, arfsBytes(arfsZip.originalBase64));
    const lasFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/las/independent.json", import.meta.url), "utf8"),
          );
          return fixture.fixtures.find((entry) =>
            entry.producer === "struct" && entry.format === 3 && entry.count === 37 && entry.extra
          );
        })(),
      )
    };
    const lasBytes = Uint8Array.from(atob(lasFixture.file.base64), (byte) => byte.charCodeAt(0));
    const las = await openLas(createByteSource(lasBytes));
    const lasRead = await las.read({ offset: 3, count: 7, scale: 'physical' });
    const lasColumn = (name, width) => Uint8Array.from(atob(lasFixture.columns[name].base64), (byte) => byte.charCodeAt(0)).subarray(3 * width, 10 * width);
    const lasBytesOf = (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    assertBytes(lasBytesOf(lasRead.X), lasColumn('X', 4));
    assertBytes(lasBytesOf(lasRead.gpsTime), lasColumn('gps_time', 8));
    assertBytes(lasBytesOf(lasRead.red), lasColumn('red', 2));
    assertBytes(lasBytesOf(lasRead.physical.x), lasColumn('x', 8));
    assertBytes(lasRead.extra, new Uint8Array([3, 4, 5, 6, 7, 8, 9]));
    if (lasRead.integrity !== 'not-provided' || las.extraBytesPerPoint !== 1 || !las.headerExtension.size) throw new Error('Packed LAS opaque/profile evidence changed');
    assertBytes((await las.readVlr(0, { offset: 3, length: 5 })).bytes, new Uint8Array([3, 4, 5, 6, 7]));
    const seafileLibrary = '11111111-1111-1111-1111-111111111111';
    const seafileBody = new Uint8Array([1, 9, 255]);
    const seafile = new SeafileClient({
      endpoint: 'https://seafile.example/', library: seafileLibrary, token: 'private-api-token',
      downloadGrants: [{ origin: 'https://seafile.example/', prefix: '/seafhttp/' }],
      uploadGrants: [{ origin: 'https://seafile.example/', prefix: '/seafhttp/' }],
      fetch: async (input, init) => {
        const url = new URL(input), headers = new Headers(init.headers);
        if (url.pathname.startsWith('/seafhttp/')) {
          if (headers.has('authorization') || init.credentials !== 'omit' || init.redirect !== 'manual') throw new Error('Packed Seafile capability authority leaked');
          if (init.method === 'POST') {
            const file = init.body.get('file');
            assertBytes(new Uint8Array(await file.arrayBuffer()), seafileBody);
            return new Response(JSON.stringify([{ id: 'opaque-file-object', name: 'native (1).bin', size: 3 }]));
          }
          return new Response(seafileBody.slice(), { headers: { 'content-length': '3' } });
        }
        if (headers.get('authorization') !== 'Token private-api-token') throw new Error('Packed Seafile API authority changed');
        if (url.pathname.endsWith('/upload-link/')) return new Response(JSON.stringify('https://seafile.example/seafhttp/upload/token'));
        if (url.pathname.endsWith('/file/')) return new Response(JSON.stringify('https://seafile.example/seafhttp/files/token/native.bin'));
        return new Response(JSON.stringify({ id: seafileLibrary, name: 'Native library', encrypted: false, permission: 'rw' }));
      },
    });
    const seafileSaved = await seafile.upload('/', 'native.bin', seafileBody);
    if (seafileSaved.name !== 'native (1).bin' || seafileSaved.size !== 3) throw new Error('Packed Seafile native collision receipt changed');
    assertBytes(await seafile.read('/' + seafileSaved.name), seafileBody);
    const zarrFixtures = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/zarr/independent.json", import.meta.url), "utf8"),
          );
          return [
            ...["C", "F"].map((order) =>
              fixture.fixtures.find((entry) =>
                entry.producer === "Zarr" && entry.dtype === ">i2" && entry.order === order
              )
            ),
            fixture.fixtures.find((entry) => entry.profile === "boolean-noncanonical"),
            fixture.fixtures.find((entry) => entry.profile === "missing"),
          ];
        })(),
      )
    };
    for (const fixture of zarrFixtures) {
      const objects = new Map(Object.entries(fixture.objects).map(([key, value]) => [key, Uint8Array.from(atob(value.base64), (byte) => byte.charCodeAt(0))]));
      const objectLedger = createZarrObjectLedger(1024);
      const array = await openZarr({ stability: 'immutable', async open(key) { const bytes = objects.get(key); return bytes ? createByteSource(bytes) : undefined; } }, { objectLedger });
      const result = await array.read();
      assertBytes(new Uint8Array(result.values.buffer, result.values.byteOffset, result.values.byteLength), Uint8Array.from(atob(fixture.original.base64), (byte) => byte.charCodeAt(0)));
      if (result.integrity !== 'not-provided' || objectLedger.inspect() < 2 || (fixture.profile === 'missing' && !result.fillMask.some(Boolean))) throw new Error('Packed Zarr object/fill scope changed');
    }
    const hamtFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/unixfs/hamt/independent.json", import.meta.url), "utf8"),
          );
          return {
            rootCid: fixture.rootCid,
            blocks: fixture.blocks,
            file: fixture.files.find((entry) => entry.path === "file-000.txt"),
            names: fixture.listings[0].expectedNames,
          };
        })(),
      )
    };
    const hamtBlocks = new Map(hamtFixture.blocks.map((entry) => [entry.cid, Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))]));
    const hamtReader = async (cid) => { const bytes = hamtBlocks.get(cid); if (!bytes) throw new Error('Packed HAMT block absent'); return bytes; };
    let hamtDefaultRefused = false;
    try { await openUnixfs(hamtFixture.rootCid, hamtReader, { subtle: globalThis.crypto.subtle }); } catch (error) { hamtDefaultRefused = error.message.includes('hamtProfile'); }
    if (!hamtDefaultRefused) throw new Error('Packed HAMT default admission changed');
    const hamt = await openUnixfs(hamtFixture.rootCid, hamtReader, { subtle: globalThis.crypto.subtle, hamtProfile: 'kubo-fanout-256' });
    if (hamt.kind !== 'hamt-directory' || hamt.profile !== 'kubo-fanout-256') throw new Error('Packed HAMT profile changed');
    const inventory = await hamt.list();
    if (inventory.scope !== 'complete-directory-links' || JSON.stringify(inventory.entries.map((entry) => entry.name).sort()) !== JSON.stringify(hamtFixture.names)) throw new Error('Packed HAMT listing scope changed');
    const hamtFile = await hamt.open(hamtFixture.file.path);
    if (hamtFile.kind !== 'file') throw new Error('Packed HAMT selected file changed');
    assertBytes((await hamtFile.read()).bytes, Uint8Array.from(atob(hamtFixture.file.base64), (byte) => byte.charCodeAt(0)));
    const fitsFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/fits/independent.json", import.meta.url), "utf8"),
          );
          return fixture.fixtures.find((entry) => entry.producer === "cfitsio").file.base64;
        })(),
      )
    };
    const fits = await openFits(createByteSource(Uint8Array.from(atob(fitsFixture), (byte) => byte.charCodeAt(0))));
    const fitsRaw = await fits.read(1);
    if (!(fitsRaw.values instanceof BigInt64Array) || fitsRaw.values[0] !== -9007199254740993n || fitsRaw.values[1] !== 9007199254740993n || fitsRaw.values[2] !== 9223372036854775807n || fitsRaw.integrity !== 'pending') throw new Error('Packed FITS exact raw integer scope changed');
    const fitsVerified = await fits.verify(1);
    if (fitsVerified.datasum !== 'verified' || fitsVerified.checksum !== 'verified' || fitsRaw.undefinedMask.some((value) => value !== 0)) throw new Error('Packed FITS padded checksum scope changed');
    const nextcloudBody = new TextEncoder().encode('native chunk bytes');
    const nextcloudMethods = [];
    const nextcloud = new NextcloudClient({
      endpoint: 'https://cloud.invalid/', user: 'caller', credentials: () => 'Bearer explicit-token',
      fetch: async (input, init) => {
        const target = new URL(input.toString()), headers = new Headers(init?.headers);
        if (headers.get('authorization') !== 'Bearer explicit-token' || target.origin !== 'https://cloud.invalid') throw new Error('Packed Nextcloud authority changed');
        nextcloudMethods.push(init.method);
        if (init.method === 'PUT') assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), nextcloudBody);
        if (init.method === 'MOVE' && (headers.get('overwrite') !== 'F' || !headers.get('destination').endsWith('/remote.php/dav/files/caller/note.txt'))) throw new Error('Packed Nextcloud publication scope changed');
        return new Response(null, { status: 201 });
      },
    });
    const nextcloudUpload = await nextcloud.createUpload('installed-fixture', 'note.txt', nextcloudBody.length);
    const nextcloudPart = await nextcloud.putPart(nextcloudUpload, 1, nextcloudBody);
    const nextcloudReceipt = await nextcloud.finishUpload(nextcloud.openUpload(JSON.parse(JSON.stringify(nextcloudUpload))), [nextcloudPart]);
    if (nextcloudReceipt.status !== 201 || nextcloudMethods.join(',') !== 'MKCOL,PUT,MOVE') throw new Error('Packed Nextcloud upload receipts changed');
    const sparseFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/tar-sparse/independent.json", import.meta.url), "utf8"),
          );
          const native = fixture.fixtures.find((entry) => entry.profile === "1.0");
          return { archive: native.archive.base64, body: native.payloads["many.bin"].base64 };
        })(),
      )
    };
    const sparseTar = await openTar(createByteSource(Uint8Array.from(atob(sparseFixture.archive), (byte) => byte.charCodeAt(0))));
    const sparseEntry = sparseTar.entries.find((entry) => entry.name === 'many.bin');
    const sparseRead = await sparseTar.read(sparseEntry.id);
    const sparseHole = sparseTar.entries.find((entry) => entry.name === 'all-hole.bin');
    const sparseHoleRead = await sparseTar.read(sparseHole.id, { length: 37, maxSourceBytes: 0, maxRequests: 0 });
    assertBytes(sparseHoleRead.bytes, new Uint8Array(37));
    if (sparseHoleRead.work.sourceBytes !== 0 || sparseHoleRead.work.requests !== 0 || sparseHoleRead.work.decodedBytes !== 37 || sparseHoleRead.work.outputBytes !== 37) throw new Error('Packed sparse TAR hole accounting changed');
    assertBytes(sparseRead.bytes, Uint8Array.from(atob(sparseFixture.body), (byte) => byte.charCodeAt(0)));
    if (sparseEntry.sparse.profile !== 'gnu-pax-1.0' || sparseEntry.sparse.mapBytes <= 512 || sparseRead.integrity !== 'header-checksum-only') throw new Error('Packed sparse TAR physical/logical evidence changed');
    const lzxFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/wim/lzx-independent.json", import.meta.url), "utf8"),
          );
          const file = fixture.images[0].files.find((entry) => entry.path === "calls.bin");
          return { archive: fixture.base64, path: file.path, body: file.base64 };
        })(),
      )
    };
    const lzx = await openWim(createByteSource(Uint8Array.from(atob(lzxFixture.archive), (byte) => byte.charCodeAt(0))), { subtle: globalThis.crypto.subtle });
    const lzxImage = await lzx.image(1);
    const lzxEntry = lzxImage.entries.find((entry) => entry.path === lzxFixture.path);
    const lzxRead = await lzxImage.read(lzxEntry.id);
    assertBytes(lzxRead.bytes, Uint8Array.from(atob(lzxFixture.body), (byte) => byte.charCodeAt(0)));
    if (lzx.profile !== 'lzx-32k-1.13' || lzxRead.integrity !== 'resource-sha1-verified' || lzxRead.lzxSteps <= 0 || lzxRead.lzxBlocks <= 0 || lzxRead.xpressSteps !== 0) throw new Error('Packed WIM LZX evidence changed');
    const supabaseBody = new TextEncoder().encode('native REST bytes');
    let supabaseAuth = 0;
    const supabase = new SupabaseClient({
      endpoint: 'https://storage.invalid/storage/v1/', bucket: 'notes',
      credentials: () => { supabaseAuth++; return { accessToken: 'api-token', apiKey: 'gateway' }; },
      signedOrigins: ['https://storage.invalid'],
      fetch: async (input, init) => {
        const target = new URL(input.toString()), headers = new Headers(init?.headers);
        if (target.pathname.includes('/object/sign/') && init?.method === 'POST') {
          if (headers.get('authorization') !== 'Bearer api-token') throw new Error('Packed Supabase API authority changed');
          return new Response(JSON.stringify({ signedURL: '/object/sign/notes/note.txt?token=explicit-capability' }));
        }
        if (headers.has('authorization') || headers.has('apikey')) throw new Error('Packed Supabase media leaked API context');
        return new Response(supabaseBody.slice());
      },
    });
    assertBytes(await supabase.read('note.txt', { access: 'public' }), supabaseBody);
    const supabaseSigned = await supabase.createSignedUrl('note.txt', { expiresIn: 60 });
    assertBytes(await supabase.readSigned('note.txt', supabaseSigned), supabaseBody);
    if (supabaseAuth !== 1) throw new Error('Packed Supabase public/signed credentials changed');
    const rarFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/rar/independent.json", import.meta.url), "utf8"),
          );
          const native = fixture.fixtures.find((entry) => entry.profile === "stored");
          return { archive: native.archive.base64, body: native.payloads["hello.txt"].base64 };
        })(),
      )
    };
    const rar = await openRar(createByteSource(Uint8Array.from(atob(rarFixture.archive), (byte) => byte.charCodeAt(0))));
    const rarHello = rar.entries.find((entry) => entry.name === 'hello.txt');
    const rarRead = await rar.read(rarHello.id);
    assertBytes(rarRead.bytes, Uint8Array.from(atob(rarFixture.body), (byte) => byte.charCodeAt(0)));
    if (rar.metadata !== 'header-crc32-verified' || rarRead.integrity !== 'crc32-verified') throw new Error('Packed RAR checksum scopes changed');
    const xpressFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/wim/xpress-independent.json", import.meta.url), "utf8"),
          );
          const file = fixture.images[0].files.find((entry) => entry.path === "long.bin");
          return { archive: fixture.base64, path: file.path, body: file.base64 };
        })(),
      )
    };
    const xpress = await openWim(createByteSource(Uint8Array.from(atob(xpressFixture.archive), (byte) => byte.charCodeAt(0))), { subtle: globalThis.crypto.subtle });
    const xpressImage = await xpress.image(1);
    const xpressEntry = xpressImage.entries.find((entry) => entry.path === xpressFixture.path);
    const xpressRead = await xpressImage.read(xpressEntry.id);
    assertBytes(xpressRead.bytes, Uint8Array.from(atob(xpressFixture.body), (byte) => byte.charCodeAt(0)));
    if (xpress.profile !== 'xpress-huffman-32k-1.13' || xpressRead.integrity !== 'resource-sha1-verified' || xpressRead.xpressSteps <= 0) throw new Error('Packed WIM XPRESS evidence changed');
    const wimFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/wim/independent.json", import.meta.url), "utf8"),
          );
          return {
            archive: fixture.base64,
            body: fixture.images[0].files.find((entry) => entry.path === "hello.txt").base64,
          };
        })(),
      )
    };
    const wim = await openWim(createByteSource(Uint8Array.from(atob(wimFixture.archive), (byte) => byte.charCodeAt(0))), { subtle: globalThis.crypto.subtle });
    const wimImage = await wim.image(1);
    const wimHello = wimImage.entries.find((entry) => entry.path === 'hello.txt');
    const wimRead = await wimImage.read(wimHello.id);
    assertBytes(wimRead.bytes, Uint8Array.from(atob(wimFixture.body), (byte) => byte.charCodeAt(0)));
    if (wimImage.metadataIntegrity !== 'resource-sha1-verified' || wimRead.integrity !== 'resource-sha1-verified') throw new Error('Packed WIM checksum scopes changed');
    const xarFixture = ${
      JSON.stringify(
        await (async () => {
          const fixture = JSON.parse(
            await readFile(new URL("../fixtures/xar/independent.json", import.meta.url), "utf8"),
          );
          return {
            archive: fixture.objects.find((entry) => entry.compression === "gzip" && entry.algorithm === "sha1").base64,
            body: fixture.records.find((entry) => entry.path === "hello.txt").base64,
          };
        })(),
      )
    };
    const xar = await openXar(createByteSource(Uint8Array.from(atob(xarFixture.archive), (byte) => byte.charCodeAt(0))), { subtle: globalThis.crypto.subtle });
    const xarHello = xar.entries.find((entry) => entry.path === 'hello.txt');
    const xarRead = await xar.read(xarHello.id);
    assertBytes(xarRead.bytes, Uint8Array.from(atob(xarFixture.body), (byte) => byte.charCodeAt(0)));
    if (xar.toc.status !== 'verified' || xarRead.archived !== 'verified' || xarRead.extracted !== 'verified') throw new Error('Packed XAR checksum scopes changed');
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
    import { SftpClient } from '@okikio/opfs/sftp';
    import { openBagit } from '@okikio/opfs/archive/bagit';
    import { openOcfl } from '@okikio/opfs/archive/ocfl';
    import { DropboxClient, contentHash as dropboxContentHash } from '@okikio/opfs/dropbox';
    import { BoxClient } from '@okikio/opfs/box';
    import { createLz4Decoder } from '@okikio/opfs/archive/lz4';
    import { openArc } from '@okikio/opfs/archive/arc';
    import { openIso } from '@okikio/opfs/archive/iso';
    import { openXar } from '@okikio/opfs/archive/xar';
    import { openWim } from '@okikio/opfs/archive/wim';
    import { createLzmaDecoder } from '@okikio/opfs/archive/lzma';
    import { PcloudClient } from '@okikio/opfs/pcloud';
    import { YandexClient } from '@okikio/opfs/yandex';
    import { FirebaseClient } from '@okikio/opfs/firebase';
    import { openUdf } from '@okikio/opfs/archive/udf';
    import { createBzipDecoder } from '@okikio/opfs/archive/bzip';
    import { PocketbaseClient } from '@okikio/opfs/pocketbase';
    import { SupabaseClient } from '@okikio/opfs/supabase';
    import { NextcloudClient } from '@okikio/opfs/nextcloud';
    import { ResticClient } from '@okikio/opfs/restic';
    import { LakefsClient } from '@okikio/opfs/lakefs';
    import { createGcsClient, GcsStorageClassSchema } from '@okikio/opfs/gcs';
    import { openFits } from '@okikio/opfs/dataset/fits';
    import { openNetcdf } from '@okikio/opfs/dataset/netcdf';
    import { openZarr, createZarrObjectLedger } from '@okikio/opfs/dataset/zarr';
    import { openLas } from '@okikio/opfs/dataset/las';
    import { openArfs } from '@okikio/opfs/content/arfs';
    import { SeafileClient } from '@okikio/opfs/seafile';
    import { openUnixfs } from '@okikio/opfs/content/unixfs';
    import { openRar } from '@okikio/opfs/archive/rar';
    import { openXz } from '@okikio/opfs/archive/xz';
    import { LfsClient, decodeLfsPointer, encodeLfsPointer, lfsPointerObject } from '@okikio/opfs/content/lfs';
    import { openGitObject, encodeGitTree } from '@okikio/opfs/content/git';
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
    const cabRole: 'covering' | 'history' | undefined = (await cab.read(0)).blocks[0]?.role;
    const cabDeflateBlocks: number = (await cab.read(0, { maxDeflateBlocks: 8192 })).deflateBlocks;
    void [cabRole, cabDeflateBlocks];
    const warc = await openWarc(createByteSource(new Uint8Array()));
    const readable: boolean = warc.entries[0]!.readable;
    const mime = await openMime(createByteSource(new Uint8Array()));
    const mimeComplete: boolean = (await mime.prefix(0, 1)).complete;
    const seven = await openSeven(createByteSource(new Uint8Array()));
    const sevenReadable: boolean = seven.entries[0]!.readable;
    const sevenCodecPolicy: import('@okikio/opfs/archive/seven').SevenLzmaOptionsType = { maxDictionaryBytes: 65536 };
    const sevenHeader: string | undefined = seven.headers.decoded?.method;
    const sevenDecoding: 'complete' | 'prefix' | undefined = (await seven.read(0, { lzma: sevenCodecPolicy })).decoding;
    void [sevenHeader, sevenDecoding];
    const ar = await openAr(createByteSource(new Uint8Array()));
    const arSource = ar.member(0);
    const mbox = await openMbox(createByteSource(new Uint8Array()), { dialect: 'mboxrd' });
    const mboxSource = (await mbox.openMessage(0, { trailing: 'preserve' })).source;
    const ftp = new FtpClient({ host: 'types.invalid', username: 'user', password: 'password', mode: 'plain', transport: { async connect() { throw new Error('types only'); } } });
    const ftpDone: Promise<void> = ftp.close();
    const sftp = new SftpClient({ async openChannel() { throw new Error('types only'); } });
    const sftpDone: Promise<void> = sftp.close();
    const bag = await openBagit([]);
    const bagProof: 'supplied-inventory' = bag.coverage.scope;
    const ocfl = await openOcfl([]);
    const ocflProof: 'supplied-object-files' = ocfl.coverage.scope;
    void ocflProof;
    const dropbox = new DropboxClient({ token: () => 'types-only' });
    const dropboxHash: string = await dropboxContentHash(new Uint8Array(), { subtle: globalThis.crypto.subtle });
    void [dropbox, dropboxHash];
    const box = new BoxClient({ token: () => 'types-only' });
    const lz4 = createLz4Decoder(new Blob().stream());
    const finished: Promise<import('@okikio/opfs/archive/lz4').Lz4ResultType> = lz4.finished;
    void [box, finished];
    const arc = await openArc(createByteSource(new Uint8Array()));
    const gitObject = await openGitObject(createByteSource(new Uint8Array()), { algorithm: 'sha256', oid: '0'.repeat(64), subtle: globalThis.crypto.subtle });
    const gitIntegrity: import('@okikio/opfs/content/git').GitAlgorithmType = gitObject.integrity;
    const gitTree: Uint8Array = encodeGitTree([], { algorithm: 'sha256' });
    void [gitIntegrity, gitTree];
    const firebase = new FirebaseClient({ bucket: 'demo-opfs.appspot.com', credentials: () => ({ idToken: 'types-only' }) });
    const firebaseMetadata: import('@okikio/opfs/firebase').FirebaseMetadataType = await firebase.stat('packed');
    const firebaseStatus: import('@okikio/opfs/firebase').FirebaseStatusType = await firebase.statusUpload({ url: 'https://firebasestorage.googleapis.com/v0/b/demo-opfs.appspot.com/o?name=packed&upload_id=types', bucket: 'demo-opfs.appspot.com', name: 'packed', size: 3 });
    void [firebaseMetadata, firebaseStatus];
    const xz: import('@okikio/opfs/archive/xz').XzArchiveType = await openXz(createByteSource(new Uint8Array()));
    const xzRead: import('@okikio/opfs/archive/xz').XzReadType = await xz.read({ length: 1 });
    const lfs = new LfsClient({ endpoint: 'https://repo.example/lfs/', subtle: globalThis.crypto.subtle });
    const pointer: import('@okikio/opfs/content/lfs').LfsPointerType = decodeLfsPointer(new Uint8Array());
    const lfsReady: readonly import('@okikio/opfs/content/lfs').LfsResultType[] = await lfs.batch('download', [{ oid: '0'.repeat(64), size: 1 }]);
    void [xzRead, pointer, lfsReady];
    const bzip: import('@okikio/opfs/archive/bzip').BzipDecoderType = createBzipDecoder(createByteSource(new Uint8Array()));
    const bzipEnd: import('@okikio/opfs/archive/bzip').BzipResultType = await bzip.finished;
    const pocketbase = new PocketbaseClient({ endpoint: 'https://pocket.example/', collection: 'documents', field: 'files' });
    const pocketRecord: import('@okikio/opfs/pocketbase').PocketbaseRecordType = await pocketbase.getRecord('record000000001');
    void [bzipEnd, pocketRecord];
    const udf: import('@okikio/opfs/archive/udf').UdfArchiveType = await openUdf(createByteSource(new Uint8Array()));
    const udfRead: import('@okikio/opfs/archive/udf').UdfReadType = await udf.read(0, { length: 1 });
    const udfMember: import('@okikio/opfs/source').ByteSourceType = udf.member(0);
    void [udfRead, udfMember];
    const yandex = new YandexClient({ token: () => 'types-only' });
    const yandexPath: string = (await yandex.stat('disk:/packed')).path;
    void yandexPath;
    const pcloud = new PcloudClient({ endpoint: 'https://api.pcloud.com', token: () => 'types-only' });
    const pcloudId: string = (await pcloud.statFile('7')).id;
    const iso = await openIso(createByteSource(new Uint8Array()));
    const isoParents: import('@okikio/opfs/archive/iso').IsoParentMismatchType[] = [...iso.parents.mismatches];
    const lzma: import('@okikio/opfs/archive/lzma').LzmaDecoderType = createLzmaDecoder(createByteSource(new Uint8Array()), { format: 'raw-lzma2', dictionary: 8 });
    const lzmaEnd: import('@okikio/opfs/archive/lzma').LzmaResultType = await lzma.finished;
    void lzmaEnd;
    const wim = await openWim(createByteSource(new Uint8Array()), { subtle: globalThis.crypto.subtle });
    const wimProfile: 'uncompressed-1.13' | 'xpress-huffman-32k-1.13' | 'lzx-32k-1.13' = wim.profile;
    const nextcloud = new NextcloudClient({ endpoint: 'https://cloud.example/', user: 'caller', credentials: () => 'Bearer caller-token' });
    const nextcloudUpload: import('@okikio/opfs/nextcloud').NextcloudUploadType = await nextcloud.createUpload('types', 'note.bin', 1);
    const nextcloudPart: import('@okikio/opfs/nextcloud').NextcloudPartType = await nextcloud.putPart(nextcloudUpload, 1, new Uint8Array([1]));
    const nextcloudReceipt: import('@okikio/opfs/nextcloud').NextcloudReceiptType = await nextcloud.finishUpload(nextcloudUpload, [nextcloudPart]);
    void nextcloudReceipt;
    const fits: import('@okikio/opfs/dataset/fits').FitsDatasetType = await openFits(createByteSource(new Uint8Array()));
    const fitsValues: import('@okikio/opfs/dataset/fits').FitsValuesType = (await fits.read(0)).values;
    const fitsVerification: import('@okikio/opfs/dataset/fits').FitsVerificationType = await fits.verify(0);
    const gcsNative = createGcsClient({ bucket: 'types' });
    const gcsClass: import('@okikio/opfs/gcs').GcsStorageClassType = GcsStorageClassSchema.parse('ARCHIVE');
    const gcsReceipt: import('@okikio/opfs/gcs').GcsReceiptType = await gcsNative.put('object', new Uint8Array(), { storageClass: gcsClass });
    void gcsReceipt.storageClass;
    const lakefs = new LakefsClient({ endpoint: 'https://lake.example/', repository: 'types' });
    const lakefsPut: import('@okikio/opfs/lakefs').LakefsPutType = { ifNoneMatch: '*' };
    const lakefsCommit: import('@okikio/opfs/lakefs').LakefsCommitType = await lakefs.commit('branch', 'Publish');
    void [lakefsPut, lakefsCommit];
    const restic = new ResticClient({ endpoint: 'https://backup.example/repository/', subtle: globalThis.crypto.subtle });
    const resticObject: import('@okikio/opfs/restic').ResticObjectType = { kind: 'config' };
    const unixfs: import('@okikio/opfs/content/unixfs').UnixfsNodeType = await openUnixfs('cid', async () => new Uint8Array(), { subtle: globalThis.crypto.subtle });
    if (unixfs.kind === 'file') {
      const range: import('@okikio/opfs/content/unixfs').UnixfsReadType = await unixfs.read({ offset: 0, length: 0 });
      const verification: import('@okikio/opfs/content/unixfs').UnixfsVerificationType = await unixfs.verify();
      void [range, verification, unixfs.source()];
    }
    const netcdf: import('@okikio/opfs/dataset/netcdf').NetcdfDatasetType = await openNetcdf(createByteSource(new Uint8Array()), { recordVsize: 'validate' });
    const netcdfRead: import('@okikio/opfs/dataset/netcdf').NetcdfReadType = await netcdf.read(0, { missing: 'attributes', scale: 'physical' });
    const zarrStore: import('@okikio/opfs/dataset/zarr').ZarrStoreType = { stability: 'caller', async open() { return undefined; } };
    const zarr: import('@okikio/opfs/dataset/zarr').ZarrArrayType = await openZarr(zarrStore, { objectLedger: createZarrObjectLedger() });
    const zarrRead: import('@okikio/opfs/dataset/zarr').ZarrReadType = await zarr.read({ offset: 0, count: 0 });
    if (unixfs.kind === 'hamt-directory') {
      const hamt: import('@okikio/opfs/content/unixfs').UnixfsHamtType = unixfs;
      const listing: import('@okikio/opfs/content/unixfs').UnixfsListingType = await hamt.list();
      void [listing, hamt.profile];
    }
    const las: import('@okikio/opfs/dataset/las').LasDatasetType = await openLas(createByteSource(new Uint8Array()));
    const lasRead: import('@okikio/opfs/dataset/las').LasReadType = await las.read({ scale: 'physical' });
    const seafile = new SeafileClient({ endpoint: 'https://seafile.example/', library: '11111111-1111-1111-1111-111111111111', token: 'caller-token' });
    const seafileReceipt: import('@okikio/opfs/seafile').SeafileReceiptType = await seafile.upload('/', 'file', new Uint8Array());
    const arfsInput: import('@okikio/opfs/content/arfs').ArfsInputType = { drive: { transactionId: 'id', owner: 'owner', tags: [], source: createByteSource(new Uint8Array(), { identity: 'explicit' }) }, entities: [] };
    const arfs: import('@okikio/opfs/content/arfs').ArfsViewType = await openArfs(arfsInput);
    const arfsFile: import('@okikio/opfs/content/arfs').ArfsFileType = arfs.file('uuid');
    const arfsRead: import('@okikio/opfs/content/arfs').ArfsReadType = await arfsFile.read({ transactionId: 'data', source: createByteSource(new Uint8Array(), { identity: 'explicit-data' }) });
    void [arfsRead];
    void [lasRead, seafileReceipt];
    void [zarrRead];
    void [fitsValues, fitsVerification, restic, resticObject, netcdfRead];
    const wimImage: import('@okikio/opfs/archive/wim').WimImageViewType = await wim.image(1);
    void [wimProfile, wimImage];
    const xar = await openXar(createByteSource(new Uint8Array()), { verifyToc: false });
    const xarStatus: import('@okikio/opfs/archive/xar').XarChecksumStatusType = xar.toc.status;
    void [pcloudId, isoParents, xarStatus];
    const arcFormat: 'internet-archive-arc' = arc.format;
    void arcFormat;
    const passwordOptions = { password: new Uint8Array(), verify: true };
    void [sftpDone, bagProof, passwordOptions];
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
