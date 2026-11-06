import { z } from "zod";
import type { ByteSourceType } from "./source.ts";
import { isBytes, toView } from "./bytes.ts";

/** Cancellation for one destination operation; it never implies remote deletion. */
export interface UploadRequestOptionsType {
  readonly signal?: AbortSignal;
}

/** Authoritative destination state returned by explicit reconciliation. */
export interface UploadStatusType {
  readonly offset: number;
  readonly size: number;
  /** True only after provider-specific final publication, not merely full byte staging. */
  readonly complete: boolean;
  readonly expires?: string;
}

/**
 * One exclusively owned upload session, independent of filesystem semantics.
 *
 * The application must serialize writers and persist checkpoints atomically.
 * write() resolves only after the destination acknowledges the exact bytes.
 * status() must distinguish committed offsets from in-flight client progress.
 */
export interface UploadDestinationType {
  readonly protocol: string;
  readonly url: string;
  status(options?: UploadRequestOptionsType): Promise<UploadStatusType>;
  write(offset: number, bytes: Uint8Array, options?: UploadRequestOptionsType): Promise<number>;
  /** Publishes staged bytes when the protocol has a separate commit step; must reconcile ambiguous prior commits. */
  finish?(options?: UploadRequestOptionsType): Promise<UploadStatusType>;
  terminate?(options?: UploadRequestOptionsType): Promise<void>;
}

/** Versioned durable admission data. Upload URLs can contain bearer credentials; protect the checkpoint. */
export const TransferCheckpointSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  protocol: z.ZodString;
  destination: z.ZodString;
  source: z.ZodString;
  size: z.ZodNumber;
  offset: z.ZodNumber;
  state: z.ZodEnum<{
    active: "active";
    paused: "paused";
    completed: "completed";
    cancelled: "cancelled";
  }>;
}, z.core.$strict> = z.strictObject({
  version: z.literal(1),
  protocol: z.string().min(1),
  destination: z.string().url(),
  source: z.string().min(1),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["active", "paused", "completed", "cancelled"]),
}).refine((checkpoint) => checkpoint.offset <= checkpoint.size, "Checkpoint offset exceeds source size.")
  .refine(
    (checkpoint) => checkpoint.state !== "completed" || checkpoint.offset === checkpoint.size,
    "Incomplete completed checkpoint.",
  );

/** Parsed serializable checkpoint; it contains identities and acknowledgments, never source bytes or raw keys. */
export type TransferCheckpointType = z.infer<typeof TransferCheckpointSchema>;

/** Source, destination and checkpoint ownership for one explicit continuation. */
export interface TransferOptionsType {
  readonly source: ByteSourceType;
  readonly destination: UploadDestinationType;
  readonly checkpoint: TransferCheckpointType;
  /** Atomically persists a detached checkpoint. Rejection stops before any further source read or write. */
  readonly save: (checkpoint: TransferCheckpointType) => Promise<void>;
  /** Implementation memory/request bound. Defaults to 8 MiB; maximum is 64 MiB. */
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
  /** Checked between acknowledged chunks. Returning true saves a paused checkpoint without remote deletion. */
  readonly pause?: () => boolean;
}

/**
 * A machine-readable identity, source, acknowledgement or publication-state failure.
 * Some failures occur after the destination accepted bytes. The code does not
 * establish rollback or absence of remote effects; reconcile before continuing.
 */
export class TransferError extends Error {
  readonly code: "identity" | "offset" | "state" | "source";
  constructor(code: TransferError["code"], message: string) {
    super(message);
    this.name = "TransferError";
    this.code = code;
  }
}

/** Creates initial data after session creation; the caller must save it before uploading. */
export function createTransferCheckpoint(
  source: ByteSourceType,
  destination: UploadDestinationType,
): TransferCheckpointType {
  if (!source.identity) {
    throw new TransferError("identity", "Resumable transfers require an explicit stable source identity.");
  }
  return TransferCheckpointSchema.parse({
    version: 1,
    protocol: destination.protocol,
    destination: destination.url,
    source: source.identity,
    size: source.size,
    offset: 0,
    state: "active",
  });
}

/** Rejects changed sources and mismatched destinations before network or input acquisition. */
function admission(options: TransferOptionsType): TransferCheckpointType {
  const checkpoint = TransferCheckpointSchema.parse(options.checkpoint);
  if (options.source.identity !== checkpoint.source || options.source.size !== checkpoint.size) {
    throw new TransferError("identity", "The replay source identity or size changed; create a new transfer.");
  }
  if (options.destination.url !== checkpoint.destination || options.destination.protocol !== checkpoint.protocol) {
    throw new TransferError("identity", "The destination does not match this checkpoint.");
  }
  if (checkpoint.state === "cancelled") throw new TransferError("state", "A cancelled transfer cannot resume.");
  return checkpoint;
}

/** Final publication is independent of acknowledged bytes for multipart/block destinations. */
function inspectStatus(remote: UploadStatusType, checkpoint: TransferCheckpointType): void {
  if (
    !Number.isSafeInteger(remote.offset) || remote.offset < checkpoint.offset || remote.offset > checkpoint.size ||
    remote.size !== checkpoint.size || typeof remote.complete !== "boolean" ||
    (remote.complete && remote.offset !== checkpoint.size)
  ) {
    throw new TransferError("offset", "Destination length/offset/publication conflicts with committed transfer state.");
  }
  if (checkpoint.state === "completed" && !remote.complete) {
    throw new TransferError("state", "The destination no longer confirms previously completed publication.");
  }
}

/**
 * Continues a fixed-size replayable upload using one bounded chunk at a time.
 *
 * Always reconciles the destination first. A remote offset ahead of the saved
 * offset is accepted only under the caller's exclusive session ownership and
 * unchanged source identity. A remote rollback is refused. No PATCH is retried
 * automatically: after unknown publication, call this function again to HEAD
 * the session. This is checkpoint-resumable I/O, not a workflow engine or a
 * distributed lease. Borrowed source/destination resources remain open.
 */
export async function resumeTransfer(options: TransferOptionsType): Promise<TransferCheckpointType> {
  let checkpoint = admission(options);
  const chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 64 * 1024 * 1024) {
    throw new RangeError("Transfer chunks must be between 1 byte and 64 MiB.");
  }
  options.signal?.throwIfAborted();
  const request = options.signal ? { signal: options.signal } : {};
  let remote = await options.destination.status(request);
  inspectStatus(remote, checkpoint);
  checkpoint = {
    ...checkpoint,
    offset: remote.offset,
    state: remote.complete ? "completed" : "active",
  };
  await options.save({ ...checkpoint });
  while (checkpoint.offset < checkpoint.size) {
    options.signal?.throwIfAborted();
    if (options.pause?.()) {
      checkpoint = { ...checkpoint, state: "paused" };
      await options.save({ ...checkpoint });
      return checkpoint;
    }
    const length = Math.min(chunkBytes, checkpoint.size - checkpoint.offset);
    const bytes = await options.source.read(checkpoint.offset, length, request);
    options.signal?.throwIfAborted();
    if (!isBytes(bytes)) {
      throw new TransferError("source", "Replay source did not return the exact admitted chunk.");
    }
    const view = toView(bytes);
    if (view.byteLength !== length) {
      throw new TransferError("source", "Replay source did not return the exact admitted chunk.");
    }
    const offset = await options.destination.write(checkpoint.offset, view, request);
    if (offset !== checkpoint.offset + length) {
      throw new TransferError("offset", "Destination did not acknowledge the exact chunk.");
    }
    checkpoint = { ...checkpoint, offset, state: "active" };
    await options.save({ ...checkpoint });
  }
  if (checkpoint.state !== "completed") {
    if (options.pause?.()) {
      checkpoint = { ...checkpoint, state: "paused" };
      await options.save({ ...checkpoint });
      return checkpoint;
    }
    remote = await options.destination.status(request);
    inspectStatus(remote, checkpoint);
    if (!remote.complete && options.destination.finish) {
      remote = await options.destination.finish(request);
      inspectStatus(remote, checkpoint);
    }
    if (!remote.complete) {
      throw new TransferError("state", "All bytes are acknowledged but final publication is not confirmed.");
    }
    checkpoint = { ...checkpoint, state: "completed" };
    await options.save({ ...checkpoint });
  }
  return checkpoint;
}

/**
 * Terminates the remote session, then persists a cancelled checkpoint.
 * An uncertain termination can already have deleted the upload. A failed save
 * can also leave an old local checkpoint after confirmed deletion. Preserve the
 * last saved checkpoint as local evidence, then reconcile remote state before
 * recovery; it does not prove that the upload survives. The destination resource
 * remains borrowed. See the [recovery guide](../docs/transfer.md).
 */
export async function cancelTransfer(
  destination: UploadDestinationType,
  checkpoint: TransferCheckpointType,
  save: (checkpoint: TransferCheckpointType) => Promise<void>,
  options: UploadRequestOptionsType = {},
): Promise<TransferCheckpointType> {
  const current = TransferCheckpointSchema.parse(checkpoint);
  if (destination.url !== current.destination || destination.protocol !== current.protocol) {
    throw new TransferError("identity", "The destination does not match this checkpoint.");
  }
  if (current.state === "cancelled") return current;
  if (!destination.terminate) throw new TransferError("state", "This destination does not expose remote termination.");
  await destination.terminate(options);
  const cancelled = { ...current, state: "cancelled" as const };
  await save({ ...cancelled });
  return cancelled;
}
