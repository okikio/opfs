/**
 * Read WinZip AES members (AE-1 and AE-2).
 *
 * A member's ciphertext is authenticated before any plaintext reaches a decoder. The key derivation and cipher
 * primitives live in `./cipher.ts`; this module owns framing, buffering and the order in which native calls settle.
 *
 * @module
 */
import { close } from "../../close.ts";
import { isBytes, toView } from "../../bytes.ts";
import { ArchiveBudget, ArchiveError, integer, invalid, unsupported, view } from "../record.ts";
import { crc32 } from "../../hash.ts";
import { openZipAes } from "./cipher.ts";
import type { ZipAesStateType } from "./cipher.ts";
import { readAesExtra, zip64 } from "./directory.ts";
import type { DirectoryRecordType, ZipEntryType, ZipPlanType, ZipReadOptionsType, ZipReadType } from "./types.ts";

/** AES owns a bounded ciphertext snapshot and key state. Authentication finishes before any plaintext native call. */
export async function readAesMember(
  record: DirectoryRecordType,
  boundary: number,
  options: ZipReadOptionsType,
  plan: ZipPlanType,
  budget: ArchiveBudget,
): Promise<ZipReadType> {
  const metadata = record.entry.aes!;
  const capability = options.aes!;
  const native = { subtle: capability.subtle };
  const passwordLimit = options.maxPasswordBytes ?? 1024;
  integer(passwordLimit, "maxPasswordBytes");
  if (!isBytes(options.password)) throw new TypeError("ZIP password must be explicit byte data.");
  const caller = toView(options.password);
  if (caller.length > passwordLimit) {
    throw new ArchiveError("budget-exceeded", "ZIP password exceeds maxPasswordBytes.");
  }
  // Snapshot before the first source await, so caller mutation cannot change the admitted password.
  const password = new Uint8Array(caller);
  const entry = record.entry;
  const offset = options.offset ?? 0;
  const length = plan.outputBytes;
  const complete = plan.verification === "full-member-crc";
  const signal = options.signal;
  let cipher: ZipAesStateType | undefined;
  let owned: Uint8Array<ArrayBuffer> | undefined;
  try {
    // The local fixed fields remain evidence after subsequent borrowed reads.
    const header = view(new Uint8Array(await budget.read(record.offset, 30)));
    if (
      header.getUint32(0, true) !== 0x04034b50 || header.getUint16(4, true) < (metadata.method === 0 ? 10 : 20) ||
      header.getUint16(6, true) !== record.flags || header.getUint16(8, true) !== 99
    ) {
      invalid("WinZip AES local header disagrees with directory.");
    }
    const nameSize = header.getUint16(26, true);
    const extraSize = header.getUint16(28, true);
    const dataOffset = record.offset + 30 + nameSize + extraSize;
    if (dataOffset > boundary || entry.compressedSize > boundary - dataOffset) {
      invalid("WinZip AES member data overlaps directory.");
    }
    const name = await budget.read(record.offset + 30, nameSize);
    if (name.length !== record.name.length || name.some((byte, index) => byte !== record.name[index])) {
      invalid("WinZip AES local name disagrees with directory.");
    }
    const extra = view(await budget.read(record.offset + 30 + nameSize, extraSize));
    const local = readAesExtra(extra);
    if (
      !local || local.version !== metadata.version || local.strength !== metadata.strength ||
      local.method !== metadata.method
    ) {
      invalid("WinZip AES local profile disagrees with directory.");
    }
    if (!(record.flags & 8)) {
      const sizes = zip64(
        extra,
        header.getUint32(22, true) === 0xffffffff,
        header.getUint32(18, true) === 0xffffffff,
        false,
        false,
      );
      if (
        header.getUint32(14, true) !== entry.crc32 || (sizes.size ?? header.getUint32(22, true)) !== entry.size ||
        (sizes.compressedSize ?? header.getUint32(18, true)) !== entry.compressedSize
      ) {
        invalid("WinZip AES local sizes or CRC disagree with directory.");
      }
    }
    const saltSize = metadata.strength / 16;
    if (
      entry.compressedSize < saltSize + 12 ||
      (metadata.method === 0 && entry.compressedSize - saltSize - 12 !== entry.size)
    ) {
      invalid("WinZip AES STORED ciphertext size disagrees with plaintext size.");
    }
    // Native sign/verify each copies and processes the complete ciphertext. Reserve both passes before acquisition/copy.
    budget.decoded((entry.compressedSize - saltSize - 12) * 2);
    owned = new Uint8Array(await budget.read(dataOffset, entry.compressedSize));
    const ciphertext = owned.subarray(saltSize + 2, owned.length - 10);
    cipher = await openZipAes(
      password,
      owned.subarray(0, saltSize),
      owned.subarray(saltSize, saltSize + 2),
      ciphertext,
      owned.subarray(owned.length - 10),
      native,
      signal,
    );
    if (metadata.method === 8) return await readAesDeflate(entry, options, plan, budget, cipher, ciphertext);
    const begin = complete ? 0 : Math.floor(offset / 16) * 16;
    const end = complete ? entry.size : length ? Math.min(entry.size, Math.ceil((offset + length) / 16) * 16) : begin;
    budget.output(length);
    const selected = new Uint8Array(length);
    let state = 0xffffffff;
    for (let position = begin; position < end; position += 16) {
      const blockEnd = Math.min(entry.size, position + 16);
      budget.decoded(blockEnd - position);
      const plain = await cipher.decryptBlock(position, ciphertext.subarray(position, blockEnd));
      try {
        if (complete) state = crc32(plain, state);
        const start = Math.max(offset, position);
        const finish = Math.min(offset + length, blockEnd);
        if (finish > start) selected.set(plain.subarray(start - position, finish - position), start - offset);
      } finally {
        plain.fill(0);
      }
    }
    if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw new ArchiveError("checksum-mismatch", "WinZip AE-1 plaintext CRC32 failed.");
    }
    return {
      bytes: selected,
      integrity: metadata.version === 2 ? "not-provided" : complete ? "checksum-verified" : "checksum-pending",
      encryption: { kind: "winzip-aes", authentication: "ciphertext-verified" },
      work: budget.inspect(),
    };
  } finally {
    cipher?.clear();
    password.fill(0);
    owned?.fill(0);
  }
}

/**
 * Authenticate first (in the caller), then decrypt all bounded compressed bytes, then inflate.
 * Native AES calls settle serially before any decoder exists. The compressed plaintext buffer
 * stays owned until the explicit pipeTo promise and decoder reader have both retired.
 */
async function readAesDeflate(
  entry: ZipEntryType,
  options: ZipReadOptionsType,
  plan: ZipPlanType,
  budget: ArchiveBudget,
  cipher: ZipAesStateType,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<ZipReadType> {
  const offset = options.offset ?? 0;
  const length = plan.outputBytes;
  const full = plan.verification !== "none";
  const crc = plan.verification === "full-member-crc";
  const authentication = { kind: "winzip-aes" as const, authentication: "ciphertext-verified" as const };
  if (!length && !full) {
    return {
      bytes: new Uint8Array(),
      encryption: authentication,
      integrity: entry.aes!.version === 2 ? "not-provided" : "checksum-pending",
      work: budget.inspect(),
    };
  }
  budget.decoded(ciphertext.length);
  const compressed = new Uint8Array(ciphertext.length);
  try {
    for (let position = 0; position < ciphertext.length; position += 16) {
      const plain = await cipher.decryptBlock(
        position,
        ciphertext.subarray(position, Math.min(position + 16, ciphertext.length)),
      );
      try {
        compressed.set(plain, position);
      } finally {
        plain.fill(0);
      }
    }
    options.signal?.throwIfAborted();
    budget.output(length);
    const selected = new Uint8Array(length);
    let transform: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>;
    if (options.inflate) transform = options.inflate();
    else {
      try {
        transform = new DecompressionStream("deflate-raw");
      } catch {
        unsupported("Raw-DEFLATE is unavailable; inject an explicit codec factory.");
      }
    }
    let position = 0;
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        signal.throwIfAborted();
        if (position === compressed.length) {
          controller.close();
          return;
        }
        const end = Math.min(position + 1024, compressed.length);
        controller.enqueue(compressed.slice(position, end));
        position = end;
      },
    }, { highWaterMark: 0 });
    if (transform.readable.locked || transform.writable.locked) {
      throw new TypeError("ZIP AES codec factory must return independently owned unlocked streams.");
    }
    const reader = transform.readable.getReader();
    const writing = input.pipeTo(transform.writable, { signal });
    // The hidden pipeThrough promise would not provide a settlement barrier before compressed-buffer retirement.
    void writing.catch(() => {});
    let cancellation: Promise<void> | undefined;
    const cancel = (reason?: unknown): Promise<void> => cancellation ??= reader.cancel(reason);
    const onAbort = (): void => {
      abort.abort(options.signal?.reason);
      void cancel(options.signal?.reason).catch(() => {});
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    let eof = false;
    let readFailed = false;
    let decoded = 0;
    let state = 0xffffffff;
    const failures: unknown[] = [];
    try {
      while (full || decoded < offset + length) {
        signal.throwIfAborted();
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (reason) {
          readFailed = true;
          throw reason;
        }
        signal.throwIfAborted();
        if (next.done) {
          eof = true;
          break;
        }
        if (!isBytes(next.value)) invalid("ZIP AES decoder returned a non-byte chunk.");
        const bytes = toView(next.value);
        budget.decoded(bytes.length);
        if (bytes.length > entry.size - decoded) invalid("ZIP AES decoded bytes exceed declared member size.");
        if (crc) state = crc32(bytes, state);
        const start = Math.max(offset, decoded);
        const end = Math.min(offset + length, decoded + bytes.length);
        if (end > start) selected.set(bytes.subarray(start - decoded, end - decoded), start - offset);
        decoded += bytes.length;
      }
      if ((full && decoded !== entry.size) || decoded < offset + length) {
        invalid("ZIP AES decoded member ended before declared size.");
      }
    } catch (reason) {
      failures.push(reason);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      const stop = failures.length ? failures[0] : new Error("ZIP AES prefix decoding is complete.");
      if (!eof) abort.abort(stop);
      await close([
        () => cancellation ?? (!eof && !readFailed ? cancel(stop) : undefined),
        async () => {
          try {
            await writing;
          } catch (reason) {
            // pipeTo and reader.read can report the same pipeline failure. This is one event observed twice.
            if (reason !== stop && !(failures.length && reason === failures[0])) throw reason;
          }
        },
        () => reader.releaseLock(),
      ], failures);
    }
    if (crc && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw new ArchiveError("checksum-mismatch", "WinZip AE-1 plaintext CRC32 failed.");
    }
    return {
      bytes: selected,
      encryption: authentication,
      integrity: entry.aes!.version === 2 ? "not-provided" : crc ? "checksum-verified" : "checksum-pending",
      work: budget.inspect(),
    };
  } finally {
    compressed.fill(0);
  }
}
