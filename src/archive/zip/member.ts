/**
 * Read one ZIP member: STORED, DEFLATE, BZip2 (method 12) or LZMA (method 14), plain or ZipCrypto-encrypted.
 *
 * WinZip AES members go to `./aes.ts`. A member read owns its decoder and reader; the random-access source stays
 * borrowed.
 *
 * @module
 */
import type { ByteSourceType } from "../../source.ts";
import { close } from "../../close.ts";
import { isBytes, toRequestBytes, toView } from "../../bytes.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, createView, invalid, unsupported } from "../record.ts";
import type { ArchiveWorkType } from "../record.ts";
import { crc32 } from "../../hash.ts";
import { createZipCrypto } from "./zipcrypto.ts";
import { readZipBzip } from "./bzip.ts";
import { readZipLzma } from "./lzma.ts";
import { readAesMember } from "./aes.ts";
import { hasExtra, zip64 } from "./directory.ts";
import { planRead } from "./plan.ts";
import type { DirectoryRecordType, ZipReadOptionsType, ZipReadType } from "./types.ts";

/** A member read owns its decoder/reader; the underlying random-access source stays borrowed. */
export async function readMember(
  source: ByteSourceType,
  record: DirectoryRecordType,
  boundary: number,
  options: ZipReadOptionsType,
): Promise<ZipReadType> {
  options = {
    ...options,
    ...(options.aes ? { aes: { ...options.aes } } : {}),
    ...(options.bzip ? { bzip: { ...options.bzip } } : {}),
    ...(options.lzma ? { lzma: { ...options.lzma } } : {}),
  };
  const plan = planRead(record, options);
  const aggregate = record.entry.encrypted ? createArchiveLedger(options) : undefined;
  const callerLedger = options.ledger;
  const accounting = aggregate
    ? {
      reserve(kind: keyof ArchiveWorkType, count: number): void {
        aggregate.reserve(kind, count);
        callerLedger?.reserve(kind, count);
      },
      inspect: () => aggregate.inspect(),
    }
    : undefined;
  const effective = accounting ? { ...options, ledger: accounting } : options;
  const budget = new ArchiveBudget(source, effective, options.signal);
  if (!plan.supported) {
    if (plan.reason === "budget-exceeded") {
      throw new ArchiveError("budget-exceeded", "ZIP member exceeds the admitted work/output limits.");
    }
    throw unsupported(
      plan.reason === "encrypted-member"
        ? "Encrypted ZIP member requires an exact supported encryption profile."
        : "ZIP compression method is unsupported.",
    );
  }
  const entry = record.entry;
  if (entry.encryption === "winzip-aes") return readAesMember(record, boundary, options, plan, budget);
  const cipher = entry.encryption === "zipcrypto" && options.password !== undefined
    ? createZipCrypto(options.password, options.maxPasswordBytes)
    : undefined;
  const encryption = cipher ? { encryption: { kind: "zipcrypto" as const, authentication: "none" as const } } : {};
  try {
    // Exact source ranges may share scratch storage; keep this fixed header
    // independent of the later name/extra/payload reads that reuse that storage.
    const header = createView(new Uint8Array(await budget.read(record.offset, 30)));
    if (
      header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== record.flags ||
      header.getUint16(8, true) !== entry.method
    ) throw invalid("ZIP local header disagrees with directory.");
    if (entry.method === 12 && header.getUint16(4, true) < 46) {
      throw unsupported("ZIP BZip2 requires local version-needed 4.6 or later.");
    }
    if (entry.method === 14 && header.getUint16(4, true) < 63) {
      throw unsupported("ZIP LZMA requires local version-needed 6.3 or later.");
    }
    if (cipher && header.getUint16(10, true) !== record.time) {
      throw invalid("ZIP encrypted local time disagrees with directory.");
    }
    const nameSize = header.getUint16(26, true);
    const extraSize = header.getUint16(28, true);
    const name = await budget.read(record.offset + 30, nameSize);
    if (name.length !== record.name.length || name.some((byte, index) => byte !== record.name[index])) {
      throw invalid("ZIP local name disagrees with directory.");
    }
    const dataOffset = record.offset + 30 + nameSize + extraSize;
    if (dataOffset > boundary || entry.compressedSize > boundary - dataOffset) {
      throw invalid("ZIP member data overlaps directory.");
    }
    const localExtra = cipher ? createView(await budget.read(record.offset + 30 + nameSize, extraSize)) : undefined;
    if (localExtra && hasExtra(localExtra, 0x9901)) {
      throw unsupported("ZIP AES extra fields cannot be read as ZipCrypto.");
    }
    if (!(record.flags & 8)) {
      const sizes = zip64(
        localExtra ?? createView(await budget.read(record.offset + 30 + nameSize, extraSize)),
        header.getUint32(22, true) === 0xffffffff,
        header.getUint32(18, true) === 0xffffffff,
        false,
        false,
      );
      if (
        header.getUint32(14, true) !== entry.crc32 || (sizes.size ?? header.getUint32(22, true)) !== entry.size ||
        (sizes.compressedSize ?? header.getUint32(18, true)) !== entry.compressedSize
      ) throw invalid("ZIP local sizes or checksum disagree with directory.");
    }
    const cipherHeader = cipher ? 12 : 0;
    if (entry.compressedSize < cipherHeader) throw invalid("ZIP encryption header is truncated.");
    const payloadSize = entry.compressedSize - cipherHeader;
    const payloadOffset = dataOffset + cipherHeader;
    if (entry.method === 0 && entry.size !== payloadSize) throw invalid("Stored ZIP member sizes disagree.");
    if (cipher) {
      budget.decoded(12);
      const decodedHeader = cipher.decrypt(await budget.read(dataOffset, 12));
      const expected = record.flags & 8 ? record.time >>> 8 : entry.crc32 >>> 24;
      if (decodedHeader[11] !== expected) {
        throw new ArchiveError("checksum-mismatch", "ZIP password verifier failed; wrong password or corrupt data.");
      }
    }
    const offset = options.offset ?? 0;
    const length = plan.outputBytes;
    const complete = plan.verification === "full-member-crc";
    if (entry.method === 0 && !complete && !cipher) {
      budget.decoded(length);
      budget.output(length);
      const bytes = new Uint8Array(await budget.read(dataOffset + offset, length));
      return { bytes, integrity: "checksum-pending", work: budget.inspect() };
    }
    const chunks: Uint8Array[] = [];
    let decoded = 0;
    let state = 0xffffffff;
    const consume = (value: Uint8Array, admitted = false): void => {
      if (!isBytes(value)) throw invalid("ZIP decoder returned a non-byte chunk.");
      const bytes = toView(value);
      if (!admitted) budget.decoded(bytes.byteLength);
      if (bytes.byteLength > entry.size - decoded) throw invalid("ZIP decoded bytes exceed declared member size.");
      if (complete) state = crc32(bytes, state);
      const start = Math.max(0, offset - decoded);
      const end = Math.min(bytes.byteLength, offset + length - decoded);
      if (end > start) {
        budget.output(end - start);
        const selected = bytes.slice(start, end);
        chunks.push(selected);
      }
      decoded += bytes.byteLength;
    };
    if (entry.method === 12 || entry.method === 14) {
      const terminal = entry.method === 12
        ? await readZipBzip(
          source,
          payloadOffset,
          payloadSize,
          effective,
          budget,
          complete,
          offset + length,
          consume,
        )
        : await readZipLzma(
          source,
          payloadOffset,
          payloadSize,
          entry.size,
          effective,
          budget,
          complete,
          offset + length,
          consume,
        );
      if ((complete && (terminal.status !== "complete" || decoded !== entry.size)) || decoded < offset + length) {
        throw invalid("ZIP codec member ended before its declared size.");
      }
      if (complete && terminal.integrity === "none" && terminal.termination !== "end-marker") {
        throw invalid("ZIP LZMA EOS-required member did not reach its end marker.");
      }
      if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
        throw new ArchiveError("checksum-mismatch", "ZIP member CRC32 failed.");
      }
      options.signal?.throwIfAborted();
      const work = budget.inspect();
      return {
        bytes: join(chunks, length),
        integrity: complete ? "checksum-verified" : "checksum-pending",
        codec: terminal.integrity === "none"
          ? {
            kind: "lzma",
            integrity: "none",
            termination: terminal.termination === "end-marker" ? "end-marker" : "pending",
            dictionaryBytes: terminal.dictionaryBytes,
            decisions: terminal.decisions,
            steps: terminal.steps,
          }
          : {
            kind: "bzip2",
            integrity: terminal.integrity,
            verifiedBlocks: terminal.verifiedBlocks,
            steps: terminal.steps,
            memoryBytes: terminal.memoryBytes,
          },
        work: {
          ...work,
          sourceBytes: work.sourceBytes + terminal.work.sourceBytes,
          requests: work.requests + terminal.work.requests,
        },
      };
    } else if (entry.method === 0) {
      const extent = complete ? entry.size : cipher ? offset + length : entry.size;
      for (let position = 0; position < extent; position += 65536) {
        const chunk = await budget.read(payloadOffset + position, Math.min(65536, extent - position));
        if (cipher) budget.decoded(chunk.length);
        consume(cipher ? cipher.decrypt(chunk) : chunk, Boolean(cipher));
      }
    } else {
      let position = 0;
      const abort = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
      const compressedBudget = new ArchiveBudget(source, {
        ...effective,
        maxSourceBytes: budget.limits.maxSourceBytes - budget.inspect().sourceBytes,
        maxRequests: budget.limits.maxRequests - budget.inspect().requests,
      }, signal);
      const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          if (position === payloadSize) {
            controller.close();
            return;
          }
          const size = Math.min(65536, payloadSize - position);
          let bytes = await compressedBudget.read(payloadOffset + position, size);
          if (cipher) {
            compressedBudget.decoded(size);
            bytes = cipher.decrypt(bytes);
          }
          position += size;
          // Native codec BufferSource excludes shared backing; preserve canonical
          // fixed buffers and snapshot foreign/shared ranges through the byte owner.
          controller.enqueue(toRequestBytes(bytes));
        },
      }, { highWaterMark: 0 });
      let transform: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>;
      if (options.inflate) transform = options.inflate();
      else {
        try {
          transform = new DecompressionStream("deflate-raw");
        } catch {
          throw unsupported("Raw-DEFLATE is unavailable; inject an explicit codec factory.");
        }
      }
      const reader = input.pipeThrough(transform).getReader();
      let eof = false;
      let cancellation: Promise<void> | undefined;
      const cancel = (reason?: unknown): Promise<void> => cancellation ??= reader.cancel(reason);
      const onAbort = (): void => {
        abort.abort(options.signal?.reason);
        // Observe this promise immediately; cleanup below remains its sole reporter.
        void cancel(options.signal?.reason).catch(() => {});
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      let failures: unknown[] = [];
      try {
        while (complete || decoded < offset + length) {
          signal.throwIfAborted();
          const result = await reader.read();
          signal.throwIfAborted();
          if (result.done) {
            eof = true;
            break;
          }
          consume(result.value);
        }
        if ((complete && decoded !== entry.size) || decoded < offset + length) {
          throw invalid("ZIP member ended before its declared size.");
        }
      } catch (reason) {
        failures = [reason];
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        abort.abort();
        await close([() => cancellation ?? (eof ? undefined : cancel()), () => reader.releaseLock()], failures);
      }
      const compressedWork = compressedBudget.inspect();
      const initial = budget.inspect();
      const result = join(chunks, length);
      if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
        throw new ArchiveError("checksum-mismatch", "ZIP member CRC32 failed.");
      }
      return {
        bytes: result,
        ...encryption,
        integrity: complete ? "checksum-verified" : "checksum-pending",
        work: {
          ...initial,
          sourceBytes: initial.sourceBytes + compressedWork.sourceBytes,
          requests: initial.requests + compressedWork.requests,
          decodedBytes: initial.decodedBytes + compressedWork.decodedBytes,
        },
      };
    }
    if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw new ArchiveError("checksum-mismatch", "ZIP member CRC32 failed.");
    }
    return {
      bytes: join(chunks, length),
      ...encryption,
      integrity: complete ? "checksum-verified" : "checksum-pending",
      work: budget.inspect(),
    };
  } finally {
    cipher?.clear();
  }
}

function join(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== length) throw invalid("ZIP selected output length disagrees with request.");
  return bytes;
}
