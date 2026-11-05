import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64Url } from "@std/encoding/base64url";
import { runInNewContext } from "node:vm";
import { createArweaveClient } from "../src/arweave.ts";
import { createArchiveLedger, verifyArweaveTransaction } from "../src/content/arweave.ts";
import type { ArweaveVerifyOptionsType } from "../src/content/arweave.ts";
import { createByteSource } from "../src/source.ts";
import { openArfs } from "../src/content/arfs.ts";
import fixture from "./fixtures/arweave/pss32.json" with { type: "json" };
import maximumSalt from "./fixtures/arweave/independent.json" with { type: "json" };
const encoder = new TextEncoder();
const options = (id: string): ArweaveVerifyOptionsType => ({
  expectedId: id,
  profile: "rsa4096-pss32-v2",
  subtle: crypto.subtle,
});
const row = fixture.rows[1]!;
const header = (signed: typeof row.signed): Uint8Array => {
  const { data: _data, ...rest } = signed;
  return encoder.encode(JSON.stringify(rest));
};
const original = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) % 251);
const dataOptions = { chunkProfile: "arweave-js-1.15.7" as const };
async function transaction() {
  return await verifyArweaveTransaction(header(row.signed), options(row.signed.id));
}
function fetchOf(signed: typeof row.signed, bytes: Uint8Array, seen: string[], noLength = false): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    seen.push(url);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    const body = url.includes("/tx/") ? header(signed) : bytes;
    return new Response(new Uint8Array(body), { headers: noLength ? {} : { "content-length": String(body.length) } });
  };
}

describe("scoped Arweave native signature and full-root snapshots", () => {
  it("retains the genuine Node-default maximum-salt mismatch as refusal evidence", async () => {
    let observed = false;
    const native = maximumSalt.rows[1]!;
    const subtle = {
      digest: crypto.subtle.digest.bind(crypto.subtle),
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      async verify(
        algorithm: AlgorithmIdentifier | RsaPssParams,
        key: CryptoKey,
        signature: BufferSource,
        data: BufferSource,
      ): Promise<boolean> {
        const bytes = new Uint8Array(data as ArrayBuffer);
        expect(btoa(String.fromCharCode(...bytes))).toBe(native.signatureDataBase64);
        expect(await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 478 }, key, signature, data)).toBe(true);
        observed = true;
        return await crypto.subtle.verify(algorithm, key, signature, data);
      },
    };
    await expect(verifyArweaveTransaction(header(native.signed), { ...options(native.signed.id), subtle })).rejects
      .toThrow(/signature/);
    expect(observed).toBe(true);
    expect(decodeBase64Url(native.signed.tags[2]!.value)).toEqual(Uint8Array.of(0x65, 0xcc, 0x81));
  });

  it("matches genuine offline SDK signatures and all boundary-size complete roots", async () => {
    expect(fixture.provenance.networkCalls).toBe(0);
    for (const vector of fixture.rows) {
      const signed = await verifyArweaveTransaction(header(vector.signed), {
        ...options(vector.signed.id),
        expectedOwner: vector.ownerAddress,
      });
      expect(signed.integrity).toBe("rsa-signature");
      expect(signed.data).toBe("not-checked");
      const verified = await signed.verifyData(createByteSource(original(vector.size)), dataOptions);
      const full = await verified.source.read(0, vector.size);
      expect(full.length).toBe(vector.size);
      expect(full.every((byte, index) => byte === (index * 131 + 17) % 251)).toBe(true);
      expect(verified.work.chunks).toBe(vector.chunks.length + (vector.size > 0 && vector.size % 262144 === 0 ? 1 : 0));
      expect(verified.chain).toBe("not-checked");
      expect(verified.source.stability).toBe("immutable");
      expect(signed.tags).toEqual(vector.signed.tags);
    }
  });
  it("keeps binary and ordered tags raw; UTF8 metadata conversion can refuse", async () => {
    const binary = fixture.rows.at(-1)!;
    const tx = await verifyArweaveTransaction(header(binary.signed), options(binary.signed.id));
    const verified = await tx.verifyData(createByteSource(original(binary.size)), dataOptions);
    expect(() => verified.metadata()).toThrow();
    const swapped = { ...row.signed, tags: [...row.signed.tags].reverse() };
    await expect(verifyArweaveTransaction(header(swapped), options(row.signed.id))).rejects.toThrow(/signature/);
  });
  it("separates header signature from embedded and downloaded data", async () => {
    const signed = await verifyArweaveTransaction(
      encoder.encode(JSON.stringify({ ...row.signed, data: "AA" })),
      options(row.signed.id),
    );
    await expect(signed.verifyData(createByteSource(Uint8Array.of(0)), dataOptions)).rejects.toThrow(/data_root/);
    await expect(signed.verifyData(createByteSource(new Uint8Array(2)), dataOptions)).rejects.toThrow(/data_size/);
  });
  it("rejects changed signing fields, signature, expected ID and expected owner", async () => {
    await expect(verifyArweaveTransaction(header({ ...row.signed, reward: "1" }), options(row.signed.id))).rejects
      .toThrow(/signature/);
    await expect(
      verifyArweaveTransaction(
        header({ ...row.signed, signature: fixture.rows[2]!.signed.signature }),
        options(row.signed.id),
      ),
    ).rejects.toThrow(/hash/);
    await expect(verifyArweaveTransaction(header(row.signed), { ...options(fixture.rows[2]!.signed.id) })).rejects
      .toThrow(/locator/);
    await expect(
      verifyArweaveTransaction(header(row.signed), { ...options(row.signed.id), expectedOwner: row.signed.id }),
    ).rejects.toThrow(/owner/);
  });
  it("refuses rounded format/denomination, duplicates, noncanonical base64 and unsupported envelopes before crypto", async () => {
    let calls = 0;
    const subtle = {
      ...crypto.subtle,
      digest: () => {
        calls++;
        throw Error("unexpected");
      },
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      verify: crypto.subtle.verify.bind(crypto.subtle),
    } as ArweaveVerifyOptionsType["subtle"];
    const text = new TextDecoder().decode(header(row.signed));
    for (
      const changed of [
        text.replace('"format":2', '"format":2.0000000000000001'),
        text.replace('"format":2', '"format":2,"denomination":1e-324'),
        text.replace('"format":2', '"format":2,"form\\u0061t":2'),
        text.replace('"format":2', '"format":1'),
        text.replace('"format":2', '"format":2,"unknown":0'),
      ]
    ) {
      await expect(verifyArweaveTransaction(encoder.encode(changed), { ...options(row.signed.id), subtle })).rejects
        .toThrow();
    }
    await expect(
      verifyArweaveTransaction(header({ ...row.signed, target: "A" }), { ...options(row.signed.id), subtle }),
    ).rejects.toThrow(/base64/);
    expect(calls).toBe(0);
  });
  it("uses native byte extents across realms and ignores shadow lengths", async () => {
    const raw = header(row.signed);
    const foreign = runInNewContext("new Uint8Array(bytes)", { bytes: [...raw] }) as Uint8Array;
    await verifyArweaveTransaction(foreign, options(row.signed.id));
    Object.defineProperty(raw, "byteLength", {
      get() {
        throw Error("shadow");
      },
    });
    await verifyArweaveTransaction(raw, options(row.signed.id));
    const tx = await transaction();
    const chunk = Uint8Array.of(17);
    Object.defineProperty(chunk, "byteLength", { value: 100 });
    const data = await tx.verifyData({ size: 1, read: () => Promise.resolve(chunk) }, dataOptions);
    expect(await data.source.read(0, 1)).toEqual(Uint8Array.of(17));
  });
  it("reserves full source/hash/materialization before borrowed payload IO", async () => {
    for (
      const policy of [{ maxSourceBytes: 0 }, { maxRequests: 0 }, { maxHashBytes: 0 }, { maxDigestCalls: 0 }, {
        maxMaterializedBytes: 0,
      }]
    ) {
      const tx = await transaction();
      let reads = 0;
      await expect(tx.verifyData({
        size: 1,
        read: () => {
          reads++;
          return Promise.resolve(Uint8Array.of(17));
        },
      }, { ...dataOptions, ...policy })).rejects.toThrow();
      expect(reads).toBe(0);
    }
  });
  it("retains opening budgets, distinct owners, and deduplicates an identical explicit owner", async () => {
    const ledger = createArchiveLedger(), raw = header(row.signed);
    const tx = await verifyArweaveTransaction(raw, { ...options(row.signed.id), ledger, ledgers: [ledger] });
    const other = createArchiveLedger();
    const data = await tx.verifyData(createByteSource(Uint8Array.of(17)), {
      ...dataOptions,
      ledger,
      ledgers: [ledger, other],
    });
    expect(ledger.inspect().decodedBytes).toBe(raw.length);
    expect(ledger.inspect().sourceBytes).toBe(1);
    expect(other.inspect().sourceBytes).toBe(1);
    await data.source.read(0, 1);
    expect(ledger.inspect().outputBytes).toBe(1);
    const low = await verifyArweaveTransaction(raw, { ...options(row.signed.id), maxSourceBytes: 0 });
    await expect(low.verifyData(createByteSource(Uint8Array.of(17)), dataOptions)).rejects.toThrow();
  });
  it("caps inherited explicit owners before IO", async () => {
    const tx = await verifyArweaveTransaction(header(row.signed), {
      ...options(row.signed.id),
      ledgers: Array.from({ length: 16 }, () => createArchiveLedger()),
    });
    let reads = 0;
    await expect(tx.verifyData({
      size: 1,
      read: () => {
        reads++;
        return Promise.resolve(Uint8Array.of(17));
      },
    }, { ...dataOptions, ledger: createArchiveLedger() })).rejects.toThrow(/ledger count/);
    expect(reads).toBe(0);
  });
  it("composes opening abort with fresh child signals and checks after digest", async () => {
    const controller = new AbortController();
    const tx = await verifyArweaveTransaction(header(row.signed), {
      ...options(row.signed.id),
      signal: controller.signal,
    });
    controller.abort("stop");
    await expect(
      tx.verifyData(createByteSource(Uint8Array.of(17)), { ...dataOptions, signal: new AbortController().signal }),
    ).rejects.toBe("stop");
    const later = new AbortController();
    const data = await (await transaction()).verifyData(createByteSource(Uint8Array.of(17)), {
      ...dataOptions,
      signal: later.signal,
    });
    later.abort("range-stop");
    await expect(data.source.read(0, 1, { signal: new AbortController().signal })).rejects.toBe("range-stop");
    const aborted = new AbortController();
    const subtle = {
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      verify: crypto.subtle.verify.bind(crypto.subtle),
      async digest(algorithm: AlgorithmIdentifier, input: BufferSource) {
        const result = await crypto.subtle.digest(algorithm, input);
        aborted.abort("digest-stop");
        return result;
      },
    };
    await expect(
      verifyArweaveTransaction(header(row.signed), { ...options(row.signed.id), signal: aborted.signal, subtle }),
    ).rejects.toBe("digest-stop");
  });
  it("copies source bytes before hashing and returns no mutable payload aliases", async () => {
    const chunk = Uint8Array.of(17), tx = await transaction();
    const data = await tx.verifyData({ size: 1, read: () => Promise.resolve(chunk) }, dataOptions);
    chunk[0] = 0;
    const first = await data.source.read(0, 1);
    first[0] = 0;
    expect(await data.source.read(0, 1)).toEqual(Uint8Array.of(17));
  });
  it("composes authored ArFS metadata signed by genuine SDK PSS32 with verified data", async () => {
    const convert = async (signed: typeof row.signed) => {
      const tx = await verifyArweaveTransaction(encoder.encode(JSON.stringify(signed)), options(signed.id));
      return await tx.verifyData(createByteSource(decodeBase64Url(signed.data)), dataOptions);
    };
    const records = [];
    for (const record of fixture.arfs.metadata) {
      records.push({ kind: record.kind, verified: await convert(record.signed) });
    }
    const drive = records.find((v) => v.kind === "drive")!.verified.metadata();
    const view = await openArfs({
      drive,
      entities: records.filter((v) => v.kind !== "drive").map((v) => v.verified.metadata()),
    });
    const data = await convert(row.signed);
    expect((await view.file(fixture.arfs.ids.file).read({ transactionId: data.id, source: data.source })).bytes)
      .toEqual(original(1));
  });
});

describe("explicit read-only Arweave Fetch client", () => {
  it("verifies header and exact decoded payload, then serves owned ranges without IO", async () => {
    for (const noLength of [false, true]) {
      const seen: string[] = [],
        client = createArweaveClient({
          ...options(row.signed.id),
          url: "https://gateway.invalid",
          fetch: fetchOf(row.signed, original(1), seen, noLength),
        });
      const remote = await client.open(row.signed.id);
      const verified = await remote.read(dataOptions);
      expect(await verified.source.read(0, 1)).toEqual(original(1));
      expect(seen).toEqual([`https://gateway.invalid/tx/${row.signed.id}`, `https://gateway.invalid/${row.signed.id}`]);
    }
  });
  it("does not download a signed empty payload", async () => {
    const empty = fixture.rows[0]!,
      seen: string[] = [],
      client = createArweaveClient({
        ...options(empty.signed.id),
        url: "https://gateway.invalid",
        fetch: fetchOf(empty.signed, new Uint8Array(), seen),
      });
    const data = await (await client.open(empty.signed.id)).read(dataOptions);
    expect(await data.source.read(0, 0)).toEqual(new Uint8Array());
    expect(seen).toHaveLength(1);
  });
  it("deduplicates constructor/open/read caller owners and keeps header ceiling admission visible", async () => {
    const ledger = createArchiveLedger(),
      seen: string[] = [],
      raw = header(row.signed),
      client = createArweaveClient({
        ...options(row.signed.id),
        url: "https://gateway.invalid",
        fetch: fetchOf(row.signed, original(1), seen),
        ledger,
        maxHeaderBytes: raw.length,
      });
    const data = await (await client.open(row.signed.id, { ledger })).read({ ...dataOptions, ledger });
    await data.source.read(0, 1);
    expect(ledger.inspect()).toEqual({
      sourceBytes: raw.length + 1,
      requests: 2,
      decodedBytes: raw.length,
      outputBytes: 1,
    });
  });
  it("rejects unsafe gateway locators and exhausted constructor/open budgets before Fetch", async () => {
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls++;
      throw Error("unexpected");
    };
    for (const url of ["https://user:pass@x/", "https://x/prefix/", "https://x/?q=1", "file:///x"]) {
      expect(() => createArweaveClient({ ...options(row.signed.id), url, fetch: fetcher })).toThrow();
    }
    const client = createArweaveClient({
      ...options(row.signed.id),
      url: "https://x",
      fetch: fetcher,
      maxSourceBytes: 0,
    });
    await expect(client.open(row.signed.id)).rejects.toThrow();
    await expect(client.open("../x")).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("rejects redirects and retires unused response bodies", async () => {
    let cancels = 0;
    const client = createArweaveClient({
      ...options(row.signed.id),
      url: "https://x",
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                cancels++;
              },
            }),
            { status: 302 },
          ),
        ),
    });
    await expect(client.open(row.signed.id)).rejects.toThrow(/302/);
    expect(cancels).toBe(1);
  });
  it("refuses mismatched lengths, extra/short bodies and tampered content without returning a source", async () => {
    for (const bytes of [new Uint8Array(), Uint8Array.of(17, 0), Uint8Array.of(0)]) {
      const seen: string[] = [],
        client = createArweaveClient({
          ...options(row.signed.id),
          url: "https://x",
          fetch: fetchOf(row.signed, bytes, seen, true),
        });
      const remote = await client.open(row.signed.id);
      await expect(remote.read(dataOptions)).rejects.toThrow();
    }
  });
  it("preserves constructor abort and later materialization limits", async () => {
    const controller = new AbortController(),
      seen: string[] = [],
      client = createArweaveClient({
        ...options(row.signed.id),
        url: "https://x",
        fetch: fetchOf(row.signed, original(1), seen),
        signal: controller.signal,
        maxMaterializedBytes: 1,
      });
    const remote = await client.open(row.signed.id);
    await remote.read(dataOptions);
    await expect(remote.read(dataOptions)).rejects.toThrow(/retained/);
    controller.abort("client-stop");
    await expect(remote.read({ ...dataOptions, signal: new AbortController().signal })).rejects.toBe("client-stop");
    expect(seen).toHaveLength(2);
  });
  it("reserves exhausted constructor and operation payload allowances before Fetch", async () => {
    const tx = await transaction(), seen: string[] = [], raw = header(row.signed);
    const client = createArweaveClient({
      ...options(row.signed.id),
      url: "https://x",
      fetch: fetchOf(row.signed, original(1), seen),
      maxHashBytes: tx.work.hashBytes,
      maxHeaderBytes: raw.length,
    });
    const remote = await client.open(row.signed.id);
    expect("verifyData" in remote.transaction).toBe(false);
    await expect(remote.read(dataOptions)).rejects.toThrow(/hash/);
    expect(seen).toHaveLength(1);
    const secondSeen: string[] = [],
      second = createArweaveClient({
        ...options(row.signed.id),
        url: "https://x",
        fetch: fetchOf(row.signed, original(1), secondSeen),
      });
    const open = await second.open(row.signed.id);
    await expect(open.read({ ...dataOptions, ledger: createArchiveLedger({ maxSourceBytes: 0 }) })).rejects.toThrow();
    expect(secondSeen).toHaveLength(1);
  });
  it("captures native crypto methods before Fetch can mutate the supplied capability", async () => {
    const mutable = {
      digest: crypto.subtle.digest.bind(crypto.subtle),
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      verify: crypto.subtle.verify.bind(crypto.subtle),
    };
    const delegate = fetchOf(row.signed, original(1), []);
    const client = createArweaveClient({
      ...options(row.signed.id),
      subtle: mutable,
      url: "https://x",
      fetch: (input, init) => {
        mutable.digest = () => {
          throw Error("mutated");
        };
        return delegate(input, init);
      },
    });
    const data = await (await client.open(row.signed.id)).read(dataOptions);
    expect(await data.source.read(0, 1)).toEqual(original(1));
  });
  it("preserves both malformed body and owned cancellation failures", async () => {
    const cleanup = Error("cancel failed"), raw = header(row.signed);
    let cancels = 0;
    const client = createArweaveClient({
      ...options(row.signed.id),
      url: "https://x",
      fetch: async (input) =>
        String(input).includes("/tx/")
          ? new Response(new Uint8Array(raw), { headers: { "content-length": String(raw.length) } })
          : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Uint8Array.of(17, 0));
              },
              cancel() {
                cancels++;
                throw cleanup;
              },
            }),
          ),
    });
    let caught: unknown;
    try {
      await (await client.open(row.signed.id)).read(dataOptions);
    } catch (reason) {
      caught = reason;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[1]).toBe(cleanup);
    expect(cancels).toBe(1);
  });
  it("bounds pathological empty host chunks and cancels the owned reader", async () => {
    let chunks = 0, cancels = 0;
    const client = createArweaveClient({
      ...options(row.signed.id),
      url: "https://x",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              chunks++;
              controller.enqueue(new Uint8Array());
            },
            cancel() {
              cancels++;
            },
          }),
        ),
    });
    await expect(client.open(row.signed.id)).rejects.toThrow(/chunks/);
    expect(chunks).toBeLessThanOrEqual(8193);
    expect(cancels).toBe(1);
  });
});
