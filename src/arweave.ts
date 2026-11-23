/** Explicit native Fetch reads compose signature checks with complete bounded data-root verification. @module */
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { createArchiveLedger, integer } from "./archive/record.ts";
import type { ArchiveLedgerType, ArchiveWorkType } from "./archive/record.ts";
import { ArweaveError, arweaveId, verifyArweaveTransaction } from "./content/arweave.ts";
import type {
  ArweaveDataOptionsType,
  ArweaveDataType,
  ArweaveLimitsType,
  ArweaveTransactionType,
  ArweaveVerifyOptionsType,
} from "./content/arweave.ts";

/** Constructor limits remain authoritative across all transactions created by this client. No globals are acquired. */
export interface ArweaveClientOptionsType extends Omit<ArweaveVerifyOptionsType, "expectedId" | "expectedOwner"> {
  /** An HTTP(S) origin with no user information, path prefix, query or fragment. */ readonly url: string | URL;
  readonly fetch: typeof fetch;
}
/** Open limits are inherited by its later data read. An expected owner is a computed address, not a trust anchor. */
export interface ArweaveOpenOptionsType extends ArweaveLimitsType {
  readonly expectedOwner?: string;
  readonly maxHeaderBytes?: number;
}
/** Header authenticity is separate from downloaded payload verification and chain inclusion. */
export interface ArweaveRemoteTransactionType {
  readonly transaction: Omit<ArweaveTransactionType, "verifyData">;
  /** Downloads all signed bytes once per call and returns only a completely verified owned snapshot. Empty signed data needs no download. */
  read(options: ArweaveDataOptionsType): Promise<ArweaveDataType>;
}
/** Read-only native gateway surface. No status, proof-range, upload, funding, wallet or ambient authentication route. */
export interface ArweaveClientType {
  open(id: string, options?: ArweaveOpenOptionsType): Promise<ArweaveRemoteTransactionType>;
}
function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArweaveError("budget-exceeded", `${label} exceeded.`);
}
function limit(value: number | undefined, fallback: number, hard: number, label: string): number {
  const n = value ?? fallback;
  integer(n, label);
  cap(n, hard, label);
  return n;
}
function signals(...values: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const list = [...new Set(values.filter((v): v is AbortSignal => v !== undefined))];
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : AbortSignal.any(list);
}
interface OwnersType {
  readonly external: readonly ArchiveLedgerType[];
  readonly all: readonly ArchiveLedgerType[];
  readonly signal: AbortSignal | undefined;
}
/** Flatten actual owners, never aggregate wrappers, so repeated caller ledgers are charged once. */
function owners(options: ArweaveLimitsType, parent?: OwnersType): OwnersType {
  limit(options.maxHashBytes, 67108864, 268435456, "Arweave hash bytes");
  limit(options.maxDigestCalls, 4096, 16384, "Arweave digest calls");
  limit(options.maxMaterializedBytes, 8388608, 16777216, "Arweave retained bytes");
  const supplied: ArchiveLedgerType[] = [];
  const list = options.ledgers;
  if (list !== undefined) {
    if (!Array.isArray(list)) throw new TypeError("Arweave ledgers must be a finite array.");
    const length = list.length;
    cap(length, 16, "Arweave explicit ledger count");
    for (let i = 0; i < length; i++) supplied.push(list[i]!);
  }
  const external = [
    ...new Set([...(parent?.external ?? []), ...(options.ledger ? [options.ledger] : []), ...supplied]),
  ];
  cap(external.length, 16, "Arweave inherited explicit ledger count");
  for (const owner of external) {
    if (!owner || typeof owner.reserve !== "function" || typeof owner.inspect !== "function") {
      throw new TypeError("Arweave ledger requires reserve and inspect.");
    }
  }
  const all = [...new Set([...(parent?.all ?? []), createArchiveLedger(options), ...external])];
  cap(all.length, 16, "Arweave total client ledger owners");
  return { external, all, signal: signals(parent?.signal, options.signal) };
}
function reserve(owner: OwnersType, kind: keyof ArchiveWorkType, count: number): void {
  for (const ledger of owner.all) ledger.reserve(kind, count);
}
/** Native body allocations are host-owned; subsequent copies and retained chunks have explicit finite caps. */
interface BodyType {
  read(length: number): Promise<Uint8Array>;
  finish(): Promise<void>;
  retire(primary: readonly unknown[]): Promise<void>;
}
function bodyOf(response: Response, signal: AbortSignal | undefined, maximum: number): BodyType {
  let reads = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    ended = false,
    failed = false,
    received = 0,
    pending = new Uint8Array(0),
    offset = 0;
  const readNative = async (): Promise<void> => {
    signal?.throwIfAborted();
    cap(++reads, 8192, "Gateway body chunks");
    if (!reader) {
      if (!response.body) {
        ended = true;
        return;
      }
      reader = response.body.getReader();
    }
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch (reason) {
      failed = true;
      throw reason;
    }
    signal?.throwIfAborted();
    if (next.done) {
      ended = true;
      pending = new Uint8Array(0);
      offset = 0;
      return;
    }
    if (!isBytes(next.value)) throw new TypeError("Gateway body returned a non-byte chunk.");
    const view = toView(next.value);
    cap(view.byteLength, maximum - received, "Gateway declared body extent");
    received += view.byteLength;
    pending = new Uint8Array(view);
    offset = 0;
  };
  return {
    async read(length) {
      const out = new Uint8Array(length);
      let at = 0;
      while (at < length) {
        signal?.throwIfAborted();
        if (offset === pending.length) {
          if (ended) throw new ArweaveError("invalid-transaction", "Gateway body ended before its declared extent.");
          await readNative();
          continue;
        }
        const n = Math.min(length - at, pending.length - offset);
        out.set(pending.subarray(offset, offset + n), at);
        offset += n;
        at += n;
      }
      return out;
    },
    async finish() {
      while (!ended) {
        if (offset < pending.length) {
          throw new ArweaveError("invalid-transaction", "Gateway body exceeds its declared extent.");
        }
        await readNative();
        if (pending.length !== 0) {
          throw new ArweaveError("invalid-transaction", "Gateway body exceeds its declared extent.");
        }
      }
      signal?.throwIfAborted();
    },
    async retire(primary) {
      const actions: (() => void | PromiseLike<unknown>)[] = [];
      if (reader) {
        const held = reader;
        if (!ended && !failed) actions.push(() => held.cancel(primary[0]));
        actions.push(() => held.releaseLock());
      } else if (response.body) actions.push(() => response.body!.cancel(primary[0]));
      await close(actions, primary);
    },
  };
}
/** Request ownership begins only after all caller policies and locators are admitted. Responses never redirect. */
export function createArweaveClient(input: ArweaveClientOptionsType): ArweaveClientType {
  const options = { ...input }, origin = new URL(String(options.url));
  if (
    !["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" ||
    origin.search || origin.hash
  ) throw new TypeError("Arweave gateway requires a bare HTTP(S) origin.");
  if (typeof options.fetch !== "function") throw new TypeError("Arweave client requires an explicit Fetch capability.");
  if (options.profile !== "rsa4096-pss32-v2") {
    throw new ArweaveError(
      "unsupported-profile",
      "Arweave client requires the explicit RSA4096-PSS32 format 2 profile.",
    );
  }
  const fetcher = options.fetch,
    subtle = options.subtle,
    digest = subtle.digest.bind(subtle),
    importKey = subtle.importKey.bind(subtle),
    verify = subtle.verify.bind(subtle);
  const hashMax = limit(options.maxHashBytes, 67108864, 268435456, "Arweave client hash bytes"),
    callsMax = limit(options.maxDigestCalls, 4096, 16384, "Arweave client digest calls"),
    materializedMax = limit(options.maxMaterializedBytes, 8388608, 16777216, "Arweave client retained data"),
    headerMax = limit(options.maxHeaderBytes, 1048576, 4194304, "Arweave client header");
  limit(options.maxTags, 256, 2048, "Arweave tags");
  limit(options.maxTagBytes, 65536, 262144, "Arweave tag bytes");
  limit(options.maxDecimalDigits, 128, 512, "Arweave decimal digits");
  let hashes = 0, calls = 0, materialized = 0;
  const lifetime = owners(options);
  /** Constructor crypto allowance is reserved atomically; a transaction's private credits cannot be stolen by another open. */
  const reserveCrypto = (bytes: number, count: number): void => {
    cap(bytes, hashMax - hashes, "Arweave client cumulative hash bytes");
    cap(count, callsMax - calls, "Arweave client cumulative digest calls");
    hashes += bytes;
    calls += count;
  };
  const request = async (path: string, owner: OwnersType): Promise<Response> => {
    owner.signal?.throwIfAborted();
    return await fetcher(new URL(path, origin), {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      ...(owner.signal ? { signal: owner.signal } : {}),
    });
  };
  const admit = async (response: Response, owner: OwnersType): Promise<void> => {
    try {
      owner.signal?.throwIfAborted();
      if (response.status !== 200) {
        throw new ArweaveError(
          "invalid-transaction",
          `Gateway returned HTTP ${response.status}; only an exact 200 response is accepted.`,
        );
      }
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding !== "identity") {
        throw new ArweaveError("unsupported-profile", "Gateway content encoding must be absent or identity.");
      }
    } catch (reason) {
      await close(response.body ? [() => response.body!.cancel(reason)] : [], [reason]);
    }
  };
  return Object.freeze({
    async open(value: string, call: ArweaveOpenOptionsType = {}): Promise<ArweaveRemoteTransactionType> {
      call = { ...call };
      const id = arweaveId(value), owner = owners(call, lifetime);
      owner.signal?.throwIfAborted();
      if (call.expectedOwner !== undefined) arweaveId(call.expectedOwner);
      const max = limit(call.maxHeaderBytes, headerMax, headerMax, "Arweave open header");
      // Reserve the finite control-body ceiling before Fetch, not after an opaque host allocation.
      reserve(owner, "sourceBytes", max);
      reserve(owner, "requests", 1);
      const response = await request(`/tx/${id}`, owner);
      await admit(response, owner);
      const lengthText = response.headers.get("content-length");
      let length: number | undefined;
      if (lengthText !== null) {
        if (
          !/^(?:0|[1-9][0-9]*)$/.test(lengthText) || !Number.isSafeInteger(Number(lengthText)) ||
          Number(lengthText) > max
        ) {
          await close(response.body ? [() => response.body!.cancel()] : [], [
            new ArweaveError("budget-exceeded", "Gateway control body length exceeds its bounded profile."),
          ]);
        }
        length = Number(lengthText);
      }
      const body = bodyOf(response, owner.signal, max);
      let raw: Uint8Array;
      try {
        if (length !== undefined) {
          raw = await body.read(length);
          await body.finish();
        } else {
          // Unknown length is collected into one pre-admitted finite buffer. A capped host chunk is copied once.
          if (!response.body) raw = new Uint8Array();
          else {
            // The finite ceiling is the explicit missing-length policy; no unbounded stream collection.
            const reader = response.body.getReader();
            let ended = false, failed = false;
            try {
              const storage = new Uint8Array(max);
              let size = 0, reads = 0;
              while (true) {
                owner.signal?.throwIfAborted();
                cap(++reads, 8192, "Gateway control body chunks");
                let next: Awaited<ReturnType<typeof reader.read>>;
                try {
                  next = await reader.read();
                } catch (reason) {
                  failed = true;
                  throw reason;
                }
                owner.signal?.throwIfAborted();
                if (next.done) {
                  ended = true;
                  break;
                }
                if (!isBytes(next.value)) throw new TypeError("Gateway control body returned non-bytes.");
                const chunk = toView(next.value);
                cap(chunk.byteLength, max - size, "Gateway control body");
                storage.set(chunk, size);
                size += chunk.byteLength;
              }
              raw = storage.slice(0, size);
            } catch (reason) {
              await close([...(!ended && !failed ? [() => reader.cancel(reason)] : []), () => reader.releaseLock()], [
                reason,
              ]);
              throw reason;
            }
            await close([() => reader.releaseLock()]);
          }
        }
      } catch (reason) {
        if (length !== undefined) await body.retire([reason]);
        throw reason;
      }
      if (length !== undefined) await body.retire([]);
      let prepaidBytes = 0, prepaidCalls = 0;
      const crypto: ArweaveVerifyOptionsType["subtle"] = {
        importKey,
        verify,
        async digest(algorithm, data) {
          const view = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          if (prepaidCalls > 0) {
            if (view.byteLength > prepaidBytes) throw Error("Arweave client hash credit invariant failed.");
            prepaidBytes -= view.byteLength;
            prepaidCalls--;
          } else reserveCrypto(view.byteLength, 1);
          return await digest(algorithm, data);
        },
      };
      const transaction = await verifyArweaveTransaction(raw, {
        ...options,
        ...call,
        expectedId: id,
        subtle: crypto,
        maxHeaderBytes: max,
        ledgers: owner.all,
        ...(owner.signal ? { signal: owner.signal } : {}),
      });
      const { verifyData: _verifyData, ...publicHeader } = transaction;
      return Object.freeze({
        transaction: Object.freeze(publicHeader),
        async read(next: ArweaveDataOptionsType): Promise<ArweaveDataType> {
          next = { ...next };
          const reading = owners(next, owner);
          reading.signal?.throwIfAborted();
          cap(transaction.dataSize, materializedMax - materialized, "Arweave client cumulative retained data");
          // Pure verification reserves its full source/hash/materialization plan before this callback can acquire Fetch.
          let body: BodyType | undefined, offset = 0;
          const source = {
            size: transaction.dataSize,
            async read(at: number, count: number): Promise<Uint8Array> {
              if (at !== offset) throw Error("Arweave sequential source offset invariant failed.");
              if (!body) {
                const response = await request(`/${id}`, reading);
                await admit(response, reading);
                const declared = response.headers.get("content-length");
                if (declared !== null && declared !== String(transaction.dataSize)) {
                  await close(response.body ? [() => response.body!.cancel()] : [], [
                    new ArweaveError("invalid-transaction", "Gateway payload length differs from signed data_size."),
                  ]);
                }
                body = bodyOf(response, reading.signal, transaction.dataSize);
              }
              const bytes = await body.read(count);
              offset += count;
              if (offset === transaction.dataSize) await body.finish();
              return bytes;
            },
          };
          // Exact SDK writer partition count, including the terminal empty leaf at exact multiples.
          let rest = transaction.dataSize, chunkCount = 0;
          if (rest > 0) {
            while (rest >= 262144) {
              const tail = rest - 262144;
              rest -= tail > 0 && tail < 32768 ? Math.ceil(rest / 2) : 262144;
              chunkCount++;
            }
            chunkCount++;
          }
          const plannedCalls = chunkCount === 0 ? 0 : 4 * (2 * chunkCount - 1),
            plannedBytes = chunkCount === 0 ? 0 : transaction.dataSize + 128 * chunkCount + 192 * (chunkCount - 1);
          reserveCrypto(plannedBytes, plannedCalls);
          prepaidBytes += plannedBytes;
          prepaidCalls += plannedCalls;
          materialized += transaction.dataSize;
          let result: ArweaveDataType;
          try {
            result = await transaction.verifyData(source, {
              ...next,
              ledgers: reading.all,
              ...(reading.signal ? { signal: reading.signal } : {}),
            });
          } catch (reason) {
            if (body) await body.retire([reason]);
            throw reason;
          }
          if (body) await body.retire([]);
          return result;
        },
      });
    },
  });
}
