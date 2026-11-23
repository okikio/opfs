import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createArchiveLedger, openArfs } from "../src/content/arfs.ts";
import type { ArfsInputType, ArfsMetadataInputType, ArfsTagType } from "../src/content/arfs.ts";
import { createByteSource } from "../src/source.ts";
import { openZip } from "../src/archive/zip.ts";
import zipFixture from "./fixtures/arfs/zip.json" with { type: "json" };
import nativeFixture from "./fixtures/arfs/independent.json" with { type: "json" };
import { runInNewContext } from "node:vm";

const ids = {
  drive: "11111111-1111-4111-8111-111111111111",
  root: "22222222-2222-4222-8222-222222222222",
  folder: "33333333-3333-4333-8333-333333333333",
  file: "a4444444-4444-4444-8444-444444444444",
};
const transaction = (n: number): string => String.fromCharCode(65 + n).repeat(42) + "A";
const owner = transaction(10), dataTxId = transaction(11);
const original = new TextEncoder().encode("authored original file bytes");
function metadata(
  kind: "drive" | "folder" | "file",
  id: string,
  body: unknown,
  parent?: string,
  n = 0,
): ArfsMetadataInputType {
  const tags: ArfsTagType[] = [
    { name: "ArFS", value: "0.15" },
    { name: "App-Name", value: "authored test" },
    { name: "Content-Type", value: "application/json" },
    { name: "Entity-Type", value: kind },
    { name: "Drive-Id", value: ids.drive },
    { name: "Unix-Time", value: "1700000000" },
  ];
  if (kind === "drive") tags.push({ name: "Drive-Privacy", value: "public" });
  else tags.push({ name: kind === "folder" ? "Folder-Id" : "File-Id", value: id });
  if (parent !== undefined) tags.push({ name: "Parent-Folder-Id", value: parent });
  return {
    transactionId: transaction(n),
    owner,
    tags,
    source: createByteSource(new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)), {
      identity: `metadata-${n}`,
    }),
  };
}
function input(): ArfsInputType {
  return {
    drive: metadata("drive", ids.drive, { name: "drive", rootFolderId: ids.root }, undefined, 0),
    entities: [
      metadata("folder", ids.root, { name: "root" }, undefined, 1),
      metadata("folder", ids.folder, { name: "nested", isHidden: true }, ids.root, 2),
      metadata(
        "file",
        ids.file,
        {
          name: "literal/../name.zip",
          size: original.length,
          lastModifiedDate: 1700000000123,
          dataTxId,
          dataContentType: "application/octet-stream",
          url: "https://example.invalid/never-fetch",
        },
        ids.folder,
        3,
      ),
    ],
  };
}
const data = () => ({ transactionId: dataTxId, source: createByteSource(original, { identity: "data-snapshot" }) });
function replace(value: ArfsInputType, index: number, item: ArfsMetadataInputType): ArfsInputType {
  return { ...value, entities: value.entities.map((v, i) => i === index ? item : v) };
}
function withTags(item: ArfsMetadataInputType, tags: readonly ArfsTagType[]): ArfsMetadataInputType {
  return { ...item, tags };
}

describe("public ArFS supplied selected revisions", () => {
  it("reads genuine offline SDK public drive/folder/file/pin metadata and exact authored data", async () => {
    const decode = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const records = nativeFixture.metadata.map((record) => ({
      ...record,
      source: createByteSource(decode(record.bytesBase64), { identity: record.transactionId }),
    }));
    const drive = records.find((r) => r.label === "drive")!;
    const view = await openArfs({ drive, entities: records.filter((r) => r.label !== "drive") });
    expect(view.issues).toEqual([]);
    expect(view.list(nativeFixture.ids.root).entries).toHaveLength(2);
    expect(view.drive.name).toBe("Independent drive");
    expect(nativeFixture.provenance.networkCalls).toBe(0);
    for (const record of records) expect(record.nativeBuilderVerified && record.nativeSignatureVerified).toBe(true);
    const binding = {
      transactionId: nativeFixture.payload.transactionId,
      source: createByteSource(decode(nativeFixture.payload.bytesBase64), {
        identity: nativeFixture.payload.transactionId,
      }),
    };
    for (const id of [nativeFixture.ids.file, nativeFixture.ids.pin]) {
      const file = view.file(id);
      expect((await file.read(binding)).bytes).toEqual(decode(nativeFixture.original.bytesBase64));
      const { offset, length, bytesBase64 } = nativeFixture.original.range;
      expect(await file.source(binding).read(offset, length)).toEqual(decode(bytesBase64));
    }
    expect(view.file(nativeFixture.ids.pin).pinnedDataOwner).toBe(nativeFixture.payload.owner);
    expect(view.drive.metadataSource.identity).toBe(drive.transactionId);
  });

  it("validates exact authority number lexemes before binary64 rounding", async () => {
    const value = input();
    for (const field of ["size", "lastModifiedDate"]) {
      for (const token of ["1.0000000000000001", "9007199254740991.1", "1e-324", "1e0", "-0", "9007199254740992"]) {
        const body = `{"name":"x","size":1,"lastModifiedDate":0,"dataTxId":"${dataTxId}","dataContentType":"x"}`
          .replace(field === "size" ? '"size":1' : '"lastModifiedDate":0', `"${field}":${token}`);
        await expect(openArfs(replace(value, 2, metadata("file", ids.file, body, ids.root, 3)))).rejects.toThrow(
          /exact safe decimal/,
        );
      }
    }
    const custom = metadata(
      "file",
      ids.file,
      `{"name":"x","size":1,"lastModifiedDate":0,"dataTxId":"${dataTxId}","dataContentType":"x","unknown":1e-324,"nested":{"size":1.5}}`,
      ids.root,
      3,
    );
    expect((await openArfs(replace(value, 2, custom))).file(ids.file).metadataJson).toContain("1e-324");
    const drive = metadata("drive", ids.drive, {
      name: "custom drive",
      rootFolderId: ids.root,
      size: 1.5,
      lastModifiedDate: 1e-20,
    });
    const folder = metadata(
      "folder",
      ids.folder,
      { name: "custom folder", size: 1.5, lastModifiedDate: 1e-20 },
      ids.root,
      2,
    );
    const inert = await openArfs(replace({ ...value, drive }, 1, folder));
    expect(inert.drive.metadataJson).toContain('"size":1.5');
    expect(inert.list(ids.root).entries[0]?.metadataJson).toContain('"size":1.5');
  });

  it("composes the selected data source with independent Python ZIP bytes", async () => {
    const bytes = Uint8Array.from(atob(zipFixture.wireBase64), (c) => c.charCodeAt(0)), value = input();
    const selected = metadata(
      "file",
      ids.file,
      { name: "preview.zip", size: bytes.length, lastModifiedDate: 0, dataTxId, dataContentType: "application/zip" },
      ids.root,
      3,
    );
    const view = await openArfs(replace(value, 2, selected));
    const zip = await openZip(
      view.file(ids.file).source({
        transactionId: dataTxId,
        source: createByteSource(bytes, { identity: "python-zip" }),
      }),
    );
    const entry = zip.entries.find((e) => e.name === zipFixture.name)!;
    expect((await zip.read(entry.id)).bytes).toEqual(
      Uint8Array.from(atob(zipFixture.originalBase64), (c) => c.charCodeAt(0)),
    );
  });
  it("ignores caller array iterator overrides and admits cross-realm native bytes", async () => {
    const value = input(), entities = [...value.entities];
    Object.defineProperty(entities, Symbol.iterator, {
      value() {
        throw Error("foreign iterator must not run");
      },
    });
    const view = await openArfs({ ...value, entities });
    const foreign = runInNewContext("new Uint8Array([97])") as Uint8Array;
    expect(
      (await view.file(ids.file).read({
        transactionId: dataTxId,
        source: {
          ...data().source,
          read() {
            return Promise.resolve(foreign);
          },
        },
      }, { length: 1 })).bytes,
    ).toEqual(Uint8Array.of(97));
  });

  it("keeps literal names, hidden children, UUID IDs and transaction IDs distinct", async () => {
    const view = await openArfs(input());
    expect(view.profile).toBe("public-0.15");
    expect(view.scope).toBe("supplied-selected-revisions");
    expect(view.integrity).toBe("caller-supplied-metadata");
    expect(view.issues).toEqual([]);
    expect(view.list(ids.root).entries[0]?.isHidden).toBe(true);
    const file = view.file(ids.file);
    expect(file.name).toBe("literal/../name.zip");
    expect(file.transactionId).not.toBe(file.dataTxId);
    expect(file.lastModifiedDate).toBe(1700000000123);
    expect(file.unixTime).toBe(1700000000);
    const result = await file.read(data(), { offset: 9, length: 8 });
    expect(result.bytes).toEqual(original.slice(9, 17));
    expect(result.work).toEqual({ sourceBytes: 8, requests: 1, decodedBytes: 0, outputBytes: 8 });
    expect(result.integrity).toBe("caller-supplied-data");
    expect(await file.source(data()).read(0, original.length)).toEqual(original);
  });
  it("freezes owned metadata but never upgrades caller source evidence", async () => {
    const view = await openArfs(input());
    expect(Object.isFrozen(view.entities)).toBe(true);
    expect(Object.isFrozen(view.drive.tags[0])).toBe(true);
    const source = view.file(ids.file).source({
      transactionId: dataTxId,
      source: { ...data().source, stability: "caller" },
    });
    expect(source.stability).toBe("caller");
    expect(JSON.parse(source.identity!)).toEqual([transaction(3), dataTxId, "data-snapshot", original.length]);
  });
  it("rejects a data-ID or size mismatch before reading any data", async () => {
    const file = (await openArfs(input())).file(ids.file);
    let calls = 0;
    const source = {
      size: original.length,
      identity: "data",
      stability: "caller" as const,
      read() {
        calls++;
        return Promise.resolve(original);
      },
    };
    expect(() => file.source({ transactionId: transaction(12), source })).toThrow(/transaction ID/);
    expect(() => file.source({ transactionId: dataTxId, source: { ...source, size: 1 } })).toThrow(/size/);
    expect(calls).toBe(0);
  });
  it("normalizes UUID equality but retains raw UUID tag spelling", async () => {
    const value = input(), entity = value.entities[2]!;
    const upper = ids.file.toUpperCase();
    const view = await openArfs(
      replace(value, 2, withTags(entity, entity.tags.map((t) => t.name === "File-Id" ? { ...t, value: upper } : t))),
    );
    expect(view.file(upper).id).toBe(ids.file);
    expect(view.file(upper).tags.find((t) => t.name === "File-Id")?.value).toBe(upper);
  });
  it("rejects duplicate logical revisions and duplicate transactions", async () => {
    const value = input();
    await expect(openArfs({ ...value, entities: [...value.entities, value.entities[2]!] })).rejects.toThrow(
      /transaction/,
    );
    await expect(
      openArfs({ ...value, entities: [...value.entities, { ...value.entities[2]!, transactionId: transaction(5) }] }),
    ).rejects.toThrow(/logical UUID/);
  });
  it("refuses duplicate authority tags including equal values and allows repeated custom tags", async () => {
    const value = input();
    await expect(
      openArfs({ ...value, drive: withTags(value.drive, [...value.drive.tags, { name: "ArFS", value: "0.15" }]) }),
    ).rejects.toThrow(/Duplicate/);
    const view = await openArfs({
      ...value,
      drive: withTags(value.drive, [...value.drive.tags, { name: "Custom", value: "a" }, {
        name: "Custom",
        value: "b",
      }]),
    });
    expect(view.drive.tags.filter((t) => t.name === "Custom")).toHaveLength(2);
  });
  it("rejects overwritten JSON authority even when a duplicate key is escaped", async () => {
    const value = input();
    for (
      const json of [
        '{"name":"a","name":"b","rootFolderId":"' + ids.root + '"}',
        '{"name":"a","na\\u006de":"b","rootFolderId":"' + ids.root + '"}',
        '{"name":"a","rootFolderId":"' + ids.root + '","x":{"a":1,"a":2}}',
      ]
    ) {
      await expect(openArfs({ ...value, drive: metadata("drive", ids.drive, json) })).rejects.toThrow(
        /Duplicate decoded/,
      );
    }
  });
  it("rejects malformed UTF8, BOM, surrogate strings, trailing JSON and prototype keys", async () => {
    const value = input();
    for (
      const json of [
        "\ufeff{}",
        '{"name":"\\ud800","rootFolderId":"' + ids.root + '"}',
        "{} {}",
        '{"__proto__":{},"name":"a"}',
      ]
    ) await expect(openArfs({ ...value, drive: metadata("drive", ids.drive, json) })).rejects.toThrow();
    await expect(
      openArfs({
        ...value,
        drive: { ...value.drive, source: createByteSource(Uint8Array.of(0xff), { identity: "invalid" }) },
      }),
    ).rejects.toThrow(/UTF8/);
  });
  it("refuses private, historical and unsupported entity profiles", async () => {
    const value = input();
    for (
      const [name, replacement] of [["ArFS", "0.14"], ["Content-Type", "application/octet-stream"], [
        "Entity-Type",
        "snapshot",
      ], ["Drive-Privacy", "private"]]
    ) {
      await expect(openArfs({
        ...value,
        drive: withTags(value.drive, value.drive.tags.map((t) => t.name === name ? { ...t, value: replacement! } : t)),
      })).rejects.toThrow();
    }
    await expect(
      openArfs({
        ...value,
        drive: withTags(value.drive, [...value.drive.tags, { name: "Cipher", value: "AES256-GCM" }]),
      }),
    ).rejects.toThrow(/unencrypted/);
  });
  it("reports missing supplied references and rejects wrong parents and cycles", async () => {
    const value = input();
    const view = await openArfs({ ...value, entities: value.entities.slice(2) });
    expect(view.issues.map((i) => i.code)).toEqual(["missing-root-folder", "missing-parent"]);
    const cycle = replace(
      value,
      1,
      withTags(
        value.entities[1]!,
        value.entities[1]!.tags.map((t) => t.name === "Parent-Folder-Id" ? { ...t, value: ids.folder } : t),
      ),
    );
    await expect(openArfs(cycle)).rejects.toThrow(/Cycle/);
    const wrong = replace(
      value,
      1,
      withTags(
        value.entities[1]!,
        value.entities[1]!.tags.map((t) => t.name === "Parent-Folder-Id" ? { ...t, value: ids.file } : t),
      ),
    );
    await expect(openArfs(wrong)).rejects.toThrow(/selects a file/);
  });
  it("requires matching metadata owner and drive but allows third-party pin ownership", async () => {
    const value = input();
    await expect(openArfs(replace(value, 2, { ...value.entities[2]!, owner: transaction(13) }))).rejects.toThrow(
      /owner/,
    );
    const pin = metadata(
      "file",
      ids.file,
      {
        name: "pin",
        size: original.length,
        lastModifiedDate: 0,
        dataTxId,
        dataContentType: "application/octet-stream",
        pinnedDataOwner: transaction(14),
      },
      ids.root,
      3,
    );
    const view = await openArfs(replace(value, 2, pin));
    expect(view.file(ids.file).pinnedDataOwner).toBe(transaction(14));
    await expect(
      openArfs(replace(value, 2, withTags(pin, [...pin.tags, { name: "Pinned-Data-Tx", value: transaction(15) }]))),
    ).rejects.toThrow(/differs/);
  });
  it("requires explicit stable source provenance, including valid evidence enumeration", async () => {
    const value = input(), { identity: _, ...noIdentity } = value.drive.source;
    await expect(openArfs({ ...value, drive: { ...value.drive, source: noIdentity } })).rejects.toThrow(/identity/);
    await expect(
      openArfs({
        ...value,
        drive: { ...value.drive, source: { ...value.drive.source, stability: "random" as "caller" } },
      }),
    ).rejects.toThrow(/evidence/);
  });
  it("captures borrowed descriptor fields before the first await", async () => {
    const value = input();
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => release = resolve);
    const originalDrive = value.drive.source;
    const driveSource = {
      ...originalDrive,
      async read(offset: number, length: number) {
        await barrier;
        return originalDrive.read(offset, length);
      },
    };
    const tags = value.entities[2]!.tags.map((t) => ({ ...t }));
    const source = { ...value.entities[2]!.source };
    const pending = openArfs({
      ...value,
      drive: { ...value.drive, source: driveSource },
      entities: value.entities.map((e, i) => i === 2 ? { ...e, tags, source } : e),
    });
    tags[0]!.value = "bad";
    source.read = () => Promise.reject(Error("late mutation"));
    release();
    expect((await pending).file(ids.file).name).toBe("literal/../name.zip");
  });
  it("retains opening abort authority when child reads pass a fresh signal", async () => {
    const control = new AbortController(),
      view = await openArfs(input(), { signal: control.signal }),
      file = view.file(ids.file),
      source = file.source(data());
    control.abort(Error("opening stopped"));
    await expect(file.read(data(), { signal: new AbortController().signal })).rejects.toThrow(/opening stopped/);
    await expect(source.read(0, 1, { signal: new AbortController().signal })).rejects.toThrow(/opening stopped/);
  });
  it("retains source-view abort authority and abort after a borrowed callback", async () => {
    const file = (await openArfs(input())).file(ids.file), control = new AbortController();
    const source = file.source(data(), { signal: control.signal });
    control.abort(Error("view stopped"));
    await expect(source.read(0, 1, { signal: new AbortController().signal })).rejects.toThrow(/view stopped/);
    const next = new AbortController();
    await expect(file.read({
      transactionId: dataTxId,
      source: {
        ...data().source,
        read() {
          next.abort(Error("callback stopped"));
          return Promise.resolve(original);
        },
      },
    }, { signal: next.signal })).rejects.toThrow(/callback stopped/);
  });
  it("reserves all metadata before payload IO and honors lifetime and external operation ledgers", async () => {
    const value = input();
    let reads = 0;
    const counted = {
      ...value,
      drive: {
        ...value.drive,
        source: {
          ...value.drive.source,
          read() {
            reads++;
            return Promise.resolve(new Uint8Array());
          },
        },
      },
    };
    await expect(openArfs(counted, { maxSourceBytes: 1 })).rejects.toThrow(/sourceBytes/);
    expect(reads).toBe(0);
    const opening = createArchiveLedger({ maxOutputBytes: 1 });
    const file = (await openArfs(value, { ledger: opening })).file(ids.file);
    let payload = 0;
    const binding = {
      transactionId: dataTxId,
      source: {
        ...data().source,
        read() {
          payload++;
          return Promise.resolve(original);
        },
      },
    };
    await expect(file.read(binding, { length: 2 })).rejects.toThrow(/outputBytes/);
    expect(payload).toBe(0);
    const fresh = (await openArfs(value)).file(ids.file), operation = createArchiveLedger({ maxSourceBytes: 0 });
    await expect(fresh.read(binding, { length: 1, ledger: operation })).rejects.toThrow(/sourceBytes/);
    expect(payload).toBe(0);
  });
  it("deduplicates the same external ledger through metadata, source and reads", async () => {
    const value = input(),
      total = [value.drive, ...value.entities].reduce((n, e) => n + e.source.size, 0),
      ledger = createArchiveLedger();
    const file = (await openArfs(value, { ledger })).file(ids.file);
    await file.read(data(), { length: 1, ledger });
    await file.source(data(), { ledger }).read(1, 1);
    expect(ledger.inspect().sourceBytes).toBe(total + 2);
    expect(ledger.inspect().outputBytes).toBe(2);
  });
  it("bounds tags, entities, JSON depth, index and metadata bytes without reaching source IO", async () => {
    for (
      const options of [
        { maxEntities: 1 },
        { maxMetadataBytes: 1 },
        { maxTotalMetadataBytes: 1 },
        { maxIndexBytes: 1 },
        { maxTags: 1 },
        { maxTagBytes: 1 },
        { maxTagTotalBytes: 1 },
      ]
    ) await expect(openArfs(input(), options)).rejects.toThrow(/exceeded/);
    await expect(openArfs(input(), { maxJsonDepth: 0 })).rejects.toThrow(/depth/);
    await expect(openArfs(input(), { maxJsonTokens: 1 })).rejects.toThrow(/tokens|keys/);
  });
  it("rejects unsafe sizes, timestamps and noncanonical IDs before data reads", async () => {
    const value = input();
    for (const stamp of ["-1", "01", "1e3", "9007199254740992"]) {
      await expect(openArfs({
        ...value,
        drive: withTags(value.drive, value.drive.tags.map((t) => t.name === "Unix-Time" ? { ...t, value: stamp } : t)),
      })).rejects.toThrow(/Unix-Time/);
    }
    await expect(openArfs({ ...value, drive: { ...value.drive, transactionId: "A".repeat(42) + "B" } })).rejects
      .toThrow(/base64url/);
    const file = metadata(
      "file",
      ids.file,
      { name: "x", size: Number.MAX_SAFE_INTEGER + 1, lastModifiedDate: 0, dataTxId, dataContentType: "x" },
      ids.root,
      3,
    );
    await expect(openArfs(replace(value, 2, file))).rejects.toThrow(/authority fields|exact safe decimal/);
  });
  it("checks exact native view extents and bounds empty/high offsets", async () => {
    const file = (await openArfs(input())).file(ids.file);
    expect((await file.read(data(), { offset: original.length, length: 0 })).bytes.length).toBe(0);
    await expect(file.read(data(), { offset: original.length + 1, length: 0 })).rejects.toThrow();
    await expect(file.read({
      transactionId: dataTxId,
      source: {
        ...data().source,
        read() {
          return Promise.resolve(new Uint8Array(1));
        },
      },
    }, { length: 2 })).rejects.toThrow(/extent/);
    const bytes = new Uint8Array(1);
    Object.defineProperty(bytes, "byteLength", { value: 2 });
    await expect(file.read({
      transactionId: dataTxId,
      source: {
        ...data().source,
        read() {
          return Promise.resolve(bytes);
        },
      },
    }, { length: 2 })).rejects.toThrow(/extent/);
  });
});
