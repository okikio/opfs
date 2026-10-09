import { z } from "zod";
import { aggregate } from "../close.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import type { DenoKvAtomicType, DenoKvCheckType, DenoKvEntryType, DenoKvKeyType, DenoKvType } from "./deno-kv.ts";

/** Private generation protocol. Deadlines permit revocation; only version changes fence work. */
const GenerationSchema = z.object({
  version: z.literal(3),
  path: z.string(),
  generation: z.string(),
  owner: z.string(),
  state: z.enum(["writing", "published", "retired", "reclaiming", "reclaimed"]),
  deadline: z.number(),
  pins: z.number().int().nonnegative(),
  retiredAt: z.number().optional(),
  claim: z.string().optional(),
  reclaimedAt: z.number().optional(),
}).strict();
type GenerationType = z.output<typeof GenerationSchema>;

/** Pin count includes expired records until this protocol transactionally removes them. No KV TTL is used. */
const PinSchema = z.object({ token: z.string(), deadline: z.number() }).strict();
type PinType = z.output<typeof PinSchema>;

/** Shared retained-body accounting also binds every writer to the same namespace policy. */
const UsageSchema: z.ZodType<KvUsageType, KvUsageType> = z.object({
  version: z.literal(3),
  bytes: z.number().int().nonnegative(),
  generations: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive().nullable(),
  maxGenerations: z.number().int().positive().nullable(),
}).strict();
/** Retained-body accounting snapshot, including the policy shared by this KV namespace. */
export interface KvUsageType {
  /** Protocol version used to interpret the accounting record. */
  version: 3;
  /** Bytes retained across published, staged, and unreclaimed generations. */
  bytes: number;
  /** Number of retained generation records. */
  generations: number;
  /** Namespace byte limit; null means no configured byte limit. */
  maxBytes: number | null;
  /** Namespace generation limit; null means no configured generation limit. */
  maxGenerations: number | null;
}

/** Configured bounds for the private protocol; all constructors and inspection remain I/O-free. */
export interface GenerationOptionsType {
  readonly writerLeaseMs?: number;
  readonly readerLeaseMs?: number;
  readonly maxReaders?: number;
  readonly maxRetries?: number;
  readonly maxRetainedBytes?: number;
  readonly maxGenerations?: number;
  /** Test/application clock. Clock skew can revoke active work, but cannot bypass CAS fencing. */
  readonly clock?: () => number;
}

/** One operation-owned pin, retaining its attempt token through unknown acquisition/cleanup. */
export interface KvPinType {
  check(): Promise<void>;
  release(): Promise<void>;
}

/** Metadata and physical-work budgets for a maintenance pass. */
export interface GenerationCollectOptionsType {
  readonly cursor?: string;
  readonly minAgeMs: number;
  readonly maxDeletes: number;
  readonly maxScans: number;
  readonly maxPinScans: number;
  readonly tombstoneAgeMs: number;
  readonly signal?: AbortSignal;
}

/** Detailed progress; per-pass bounds alone do not bound aggregate garbage. */
export interface GenerationCollectResultType {
  generations: number;
  parts: number;
  deleted: number;
  retained: number;
  truncated: boolean;
  active: number;
  pinned: number;
  conflicts: number;
  scanned: number;
  prunedPins: number;
  cursor?: string;
}

/** A failed lease/admission is deliberate and distinct from a corrupt missing part. */
function lost(path: string, detail: string): FileSystemError {
  return new FileSystemError("locked", "generation", path, detail);
}

/**
 * Inspects one uncertain commit without replacing its actual rejection.
 * Successful inspection may establish the applied state; failed acquisition or
 * validation is an independent event, even when both reasons are null/equal.
 */
async function inspect<Value>(primary: unknown, action: () => Promise<Value>): Promise<Value> {
  try {
    return await action();
  } catch (reason) {
    throw aggregate([primary, reason], "Generation commit and outcome inspection both failed.");
  }
}

/** Validates policy before any resource is acquired. */
function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  return result;
}

/**
 * Owns every part mutation, pin, visibility fence and reclamation claim.
 *
 * Immutable generation identity is never reused. A stale operation always
 * checks a non-null state version; removing a completed tombstone cannot turn
 * that check into permission to recreate it. This module has no public resume
 * operation accepting caller-supplied generation IDs and no hidden timers.
 */
export class KvGeneration {
  readonly #db: DenoKvType;
  readonly #prefix: string;
  readonly #now: () => number;
  readonly writerLeaseMs: number;
  readonly readerLeaseMs: number;
  readonly maxReaders: number;
  readonly maxRetries: number;
  readonly #maxBytes: number | null;
  readonly #maxGenerations: number | null;
  #ready: Promise<void> | undefined;
  readonly #pending = new Map<
    string,
    { path: string; generation: string; key: DenoKvKeyType; token: string; uncertain: boolean }
  >();
  readonly #writers = new Map<string, { owner: string; ready: Promise<void> }>();

  constructor(db: DenoKvType, prefix: string, options: GenerationOptionsType) {
    this.#db = db;
    this.#prefix = prefix;
    this.#now = options.clock ?? Date.now;
    this.writerLeaseMs = limit(options.writerLeaseMs, 60_000, "writerLeaseMs");
    this.readerLeaseMs = limit(options.readerLeaseMs, 60_000, "readerLeaseMs");
    this.maxReaders = limit(options.maxReaders, 64, "maxReaders");
    this.maxRetries = limit(options.maxRetries, 64, "maxRetries");
    this.#maxBytes = options.maxRetainedBytes === undefined
      ? null
      : limit(options.maxRetainedBytes, 1, "maxRetainedBytes");
    this.#maxGenerations = options.maxGenerations === undefined
      ? null
      : limit(options.maxGenerations, 1, "maxGenerations");
  }

  #key(path: string, generation: string): DenoKvKeyType {
    return [this.#prefix, "generation", path, generation];
  }
  #pins(path: string, generation: string): DenoKvKeyType {
    return [this.#prefix, "pin", path, generation];
  }
  #part(path: string, generation: string, index: number): DenoKvKeyType {
    return [this.#prefix, "part", path, generation, index];
  }
  #usageKey(): DenoKvKeyType {
    return [this.#prefix, "usage"];
  }

  /** Initializes only the new namespace. Old live layouts cannot participate in this fencing protocol. */
  open(): Promise<void> {
    if (this.#ready !== undefined) return this.#ready;
    this.#ready = this.#initialize().catch((error) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    // One namespace identity and a fixed attempt budget remain authoritative.
    // An applied create can still reconcile successfully; unsuccessful commits
    // stay inspectable if the next probe fails or the budget is exhausted.
    const failures: unknown[] = [];
    for (let retry = 0; retry < this.maxRetries; retry++) {
      const entry = await (async () => {
        try {
          const current = await this.#db.get(this.#usageKey());
          if (current.value !== null) {
            const usage = UsageSchema.parse(current.value);
            if (usage.maxBytes !== this.#maxBytes || usage.maxGenerations !== this.#maxGenerations) {
              throw new TypeError(
                "All drivers in one Deno KV v3 namespace must use the same retention admission policy.",
              );
            }
          }
          return current;
        } catch (reason) {
          if (failures.length > 0) {
            throw aggregate([...failures, reason], "Namespace admission and outcome inspection failed.");
          }
          throw reason;
        }
      })();
      if (entry.value !== null) return;
      const value: KvUsageType = {
        version: 3,
        bytes: 0,
        generations: 0,
        maxBytes: this.#maxBytes,
        maxGenerations: this.#maxGenerations,
      };
      try {
        if ((await this.#db.atomic().check(entry).set(entry.key, value).commit()).ok) return;
      } catch (reason) {
        failures.push(reason);
      }
    }
    const exhausted = lost("/", "Cannot establish Deno KV namespace admission policy within the retry budget.");
    if (failures.length > 0) {
      throw aggregate([exhausted, ...failures], "Namespace admission exhausted its bounded commit budget.");
    }
    throw exhausted;
  }

  async #state(path: string, generation: string): Promise<DenoKvEntryType<GenerationType>> {
    const entry = await this.#db.get(this.#key(path, generation));
    if (entry.value === null || entry.versionstamp === null) throw lost(path, "Generation ownership no longer exists.");
    return { ...entry, value: GenerationSchema.parse(entry.value) };
  }

  async #usage(): Promise<DenoKvEntryType<KvUsageType>> {
    const entry = await this.#db.get(this.#usageKey());
    if (entry.value === null) throw lost("/", "Namespace accounting disappeared.");
    return { ...entry, value: UsageSchema.parse(entry.value) };
  }

  /** Explicit live probe. Unlike inspect(), this reads current aggregate retention. */
  async probe(): Promise<KvUsageType & { pendingReaders: number }> {
    await this.open();
    return { ...(await this.#usage()).value!, pendingReaders: this.#pending.size };
  }

  #capacity(usage: KvUsageType, bytes: number, generations: number): KvUsageType {
    const next = { ...usage, bytes: usage.bytes + bytes, generations: usage.generations + generations };
    if (
      !Number.isSafeInteger(next.bytes) || !Number.isSafeInteger(next.generations) || next.bytes < 0 ||
      next.generations < 0
    ) {
      throw new Error("Deno KV retained-body accounting invariant failed.");
    }
    if (
      (next.maxBytes !== null && next.bytes > next.maxBytes) ||
      (next.maxGenerations !== null && next.generations > next.maxGenerations)
    ) {
      throw new FileSystemError(
        "quota-exceeded",
        "admit",
        undefined,
        "Retained Deno KV generation capacity is full; run maintenance or increase the explicit namespace policy.",
      );
    }
    return next;
  }

  /** Returns an operation-local attempt identity; initialization is idempotent after a lost acknowledgement. */
  async #writer(path: string, generation: string): Promise<string> {
    let writer = this.#writers.get(generation);
    if (writer === undefined) {
      const owner = crypto.randomUUID();
      writer = { owner, ready: this.#begin(path, generation, owner) };
      this.#writers.set(generation, writer);
    }
    await writer.ready;
    return writer.owner;
  }

  async #begin(path: string, generation: string, owner: string): Promise<void> {
    await this.open();
    for (let retry = 0; retry < this.maxRetries; retry++) {
      const existing = await this.#db.get(this.#key(path, generation));
      if (existing.value !== null) {
        const state = GenerationSchema.parse(existing.value);
        if (state.owner === owner && state.state === "writing") return;
        throw lost(path, "Generation identity is already owned or retired; it cannot be reused.");
      }
      const usage = await this.#usage();
      const state: GenerationType = {
        version: 3,
        path,
        generation,
        owner,
        state: "writing",
        deadline: this.#now() + this.writerLeaseMs,
        pins: 0,
      };
      try {
        if (
          (await this.#db.atomic().check(existing, usage).set(existing.key, state).set(
            usage.key,
            this.#capacity(usage.value!, 0, 1),
          ).commit()).ok
        ) return;
      } catch (error) {
        const applied = await inspect(error, async () => {
          const current = await this.#db.get(existing.key);
          return current.value !== null && GenerationSchema.parse(current.value).owner === owner;
        });
        if (applied) return;
        throw error;
      }
    }
    throw lost(path, "Generation admission exceeded its contention budget.");
  }

  /** Mutates one immutable part and accounting in the same fence transaction. */
  async part(path: string, generation: string, index: number, bytes: Uint8Array): Promise<void> {
    const owner = await this.#writer(path, generation);
    const partKey = this.#part(path, generation, index);
    for (let retry = 0; retry < this.maxRetries; retry++) {
      const state = await this.#state(path, generation);
      const value = state.value!;
      if (value.owner !== owner || value.state !== "writing" || value.deadline <= this.#now()) {
        throw lost(path, "Writer lease expired or its generation was claimed.");
      }
      const part = await this.#db.get<Uint8Array>(partKey);
      if (part.value !== null) {
        if (part.value.byteLength === bytes.byteLength && part.value.every((byte, offset) => byte === bytes[offset])) {
          return;
        }
        throw new Error("Immutable generation part was assigned different bytes.");
      }
      const usage = await this.#usage();
      const transaction = this.#db.atomic().check(state, part, usage).set(partKey, bytes)
        .set(usage.key, this.#capacity(usage.value!, bytes.byteLength, 0));
      // Renewal changes the same version checked by collection. A late prepared
      // commit may apply after expiry if no claim changed this version.
      if (value.deadline - this.#now() < this.writerLeaseMs / 2) {
        transaction.set(state.key, { ...value, deadline: this.#now() + this.writerLeaseMs });
      }
      try {
        if ((await transaction.commit()).ok) return;
      } catch (error) {
        const applied = await inspect(error, async () => {
          const current = await this.#db.get<Uint8Array>(partKey);
          return current.value !== null && current.value.byteLength === bytes.byteLength &&
            current.value.every((byte, offset) => byte === bytes[offset]);
        });
        if (applied) return;
        throw error;
      }
    }
    throw lost(path, "Part admission exceeded its contention budget.");
  }

  /** Adds generation publication/retirement to the logical visibility transaction. */
  async publish(transaction: DenoKvAtomicType, path: string, next?: string, previous?: string): Promise<void> {
    if (next !== undefined) {
      const owner = await this.#writer(path, next);
      const state = await this.#state(path, next);
      if (state.value!.owner !== owner || state.value!.state !== "writing" || state.value!.deadline <= this.#now()) {
        throw lost(path, "Writer cannot publish after lease loss.");
      }
      transaction.check(state).set(state.key, { ...state.value!, state: "published" });
    }
    if (previous !== undefined && previous !== next) {
      const state = await this.#state(path, previous);
      if (state.value!.state !== "published") throw lost(path, "Predecessor publication changed before retirement.");
      transaction.check(state).set(state.key, { ...state.value!, state: "retired", retiredAt: this.#now() });
    }
  }

  /** Discards in-memory attempt state only after the caller has drained every physical task. */
  finish(generation: string): void {
    this.#writers.delete(generation);
  }

  /** Acknowledged or reconciled publication must never be destroyed by failure cleanup. */
  async published(path: string, generation: string): Promise<boolean> {
    const state = await this.#state(path, generation);
    return state.value!.state === "published" || state.value!.state === "retired";
  }

  async pin(path: string, generation: string, logical: DenoKvCheckType): Promise<KvPinType> {
    await this.open();
    if (this.#pending.size >= this.maxReaders) {
      throw lost(path, "Unknown reader cleanup capacity is full; run maintenance before admitting another reader.");
    }
    const token = crypto.randomUUID();
    const pinKey = [...this.#pins(path, generation), token];
    const attempt = { path, generation, key: pinKey, token, uncertain: false };
    this.#pending.set(token, attempt);
    try {
      for (let retry = 0; retry < this.maxRetries; retry++) {
        const state = await this.#state(path, generation);
        const pin = await this.#db.get<PinType>(pinKey);
        if (pin.value !== null) break; // Same-token reconciliation after an applied create.
        if (state.value!.state !== "published") throw lost(path, "File changed before reader pin admission.");
        if (state.value!.pins >= this.maxReaders) {
          throw lost(path, "Generation reader admission is full; release readers and retry.");
        }
        try {
          const result = await this.#db.atomic().check(logical, state, pin).set(pinKey, {
            token,
            deadline: this.#now() + this.readerLeaseMs,
          })
            .set(state.key, { ...state.value!, pins: state.value!.pins + 1 }).commit();
          if (result.ok) break;
          if (retry === this.maxRetries - 1) throw lost(path, "Reader admission exceeded its contention budget.");
        } catch (error) {
          // Retain this token. Never retry creation with another identity/count.
          attempt.uncertain = true;
          try {
            const current = await this.#db.get<PinType>(pinKey);
            if (current.value !== null && current.value.token === token) {
              this.#pending.delete(token);
              break;
            }
            await this.#release(path, generation, pinKey, token);
            this.#pending.delete(token);
          } catch (reconcile) {
            throw aggregate(
              [error, reconcile],
              `Reader acquisition outcome is unknown; attempt ${token} remains owned by maintenance.`,
            );
          }
          throw error;
        }
      }
    } finally {
      if (!attempt.uncertain) this.#pending.delete(token);
    }
    this.#pending.delete(token);
    let tail = Promise.resolve();
    let released = false;
    const check = () => {
      const result = tail.then(async () => {
        if (released) throw lost(path, "Reader pin is released.");
        for (let retry = 0; retry < this.maxRetries; retry++) {
          const state = await this.#state(path, generation);
          const pin = await this.#db.get<PinType>(pinKey);
          if (
            pin.value === null || pin.value.token !== token || pin.value.deadline <= this.#now() ||
            !["published", "retired"].includes(state.value!.state)
          ) throw lost(path, "Reader lease expired or its generation was reclaimed.");
          if (pin.value.deadline - this.#now() >= this.readerLeaseMs / 2) return;
          const deadline = this.#now() + this.readerLeaseMs;
          try {
            if (
              (await this.#db.atomic().check(state, pin).set(pinKey, { token, deadline }).set(state.key, state.value!)
                .commit()).ok
            ) return;
          } catch (error) {
            const applied = await inspect(error, async () => {
              const current = await this.#db.get<PinType>(pinKey);
              return current.value?.token === token && current.value.deadline >= deadline;
            });
            if (applied) return;
            throw error;
          }
        }
        throw lost(path, "Reader renewal exceeded its contention budget.");
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    let retirement: Promise<void> | undefined;
    return {
      check,
      release: () =>
        retirement ??= (async () => {
          released = true;
          await tail;
          this.#pending.set(token, { path, generation, key: pinKey, token, uncertain: true });
          await this.#release(path, generation, pinKey, token);
          this.#pending.delete(token);
        })(),
    };
  }

  /** Present-pin CAS decrements exactly once, even when acknowledgement is lost. */
  async #release(
    path: string,
    generation: string,
    pinKey: DenoKvKeyType,
    token: string,
    expiredAt?: number,
  ): Promise<boolean> {
    for (let retry = 0; retry < this.maxRetries; retry++) {
      const pin = await this.#db.get<PinType>(pinKey);
      if (pin.value === null && pin.versionstamp === null) return false;
      if (pin.value === null || pin.versionstamp === null) throw lost(path, "Reader pin ownership is inconsistent.");
      if (pin.value.token !== token) throw new Error("Reader token identity changed.");
      // Collection eligibility must come from the same version checked by deletion.
      // A renewal after the listing snapshot keeps its pin and exact count.
      if (expiredAt !== undefined && pin.value.deadline > expiredAt) return false;
      const state = await this.#state(path, generation);
      if (state.value!.pins < 1) throw new Error("Reader count underflow.");
      try {
        if (
          (await this.#db.atomic().check(pin, state).delete(pin.key).set(state.key, {
            ...state.value!,
            pins: state.value!.pins - 1,
          }).commit()).ok
        ) return true;
      } catch (error) {
        try {
          const current = await this.#db.get(pinKey);
          if (current.value === null && current.versionstamp === null) return true;
          if (current.value === null || current.versionstamp === null) {
            throw lost(path, "Reader pin ownership is inconsistent.");
          }
        } catch (reconcile) {
          throw aggregate([error, reconcile], "Reader release and outcome inspection both failed.");
        }
        throw error;
      }
    }
    throw lost(path, "Reader release exceeded its contention budget.");
  }

  /** Claims only unpublished writing state for abort; a possibly published generation is retained. */
  async abort(path: string, generation: string): Promise<void> {
    try {
      const entry = await this.#db.get(this.#key(path, generation));
      // Only an actually acquired absent entry proves idempotent retirement.
      // Transport and schema faults must stay visible to the cleanup owner.
      if (entry.value === null && entry.versionstamp === null) return;
      if (entry.value === null || entry.versionstamp === null) {
        throw lost(path, "Generation ownership is inconsistent.");
      }
      const state = { ...entry, value: GenerationSchema.parse(entry.value) };
      if (state.value.state !== "writing") {
        return;
      }
      const claim = crypto.randomUUID();
      const result = await this.#db.atomic().check(state).set(state.key, { ...state.value, state: "reclaiming", claim })
        .commit();
      if (result.ok) {
        await this.#reclaim(path, generation, claim, {
          minAgeMs: 0,
          maxDeletes: 10_000,
          maxScans: 20_000,
          maxPinScans: 1,
          tombstoneAgeMs: 0,
        }, {
          generations: 0,
          parts: 0,
          deleted: 0,
          retained: 0,
          truncated: false,
          active: 0,
          pinned: 0,
          conflicts: 0,
          scanned: 0,
          prunedPins: 0,
        });
      }
    } finally {
      this.finish(generation);
    }
  }

  async #reclaim(
    path: string,
    generation: string,
    claim: string,
    options: GenerationCollectOptionsType,
    result: GenerationCollectResultType,
  ): Promise<void> {
    for await (const part of this.#db.list<Uint8Array>({ prefix: [this.#prefix, "part", path, generation] })) {
      if (result.deleted >= options.maxDeletes || result.scanned >= options.maxScans) {
        result.truncated = true;
        return;
      }
      throwIfAborted(options.signal, "collect", path);
      result.parts++;
      result.scanned++;
      const state = await this.#state(path, generation);
      if (state.value!.state !== "reclaiming" || state.value!.claim !== claim) {
        result.conflicts++;
        return;
      }
      const usage = await this.#usage();
      try {
        const commit = await this.#db.atomic().check(state, part, usage).delete(part.key)
          .set(usage.key, this.#capacity(usage.value!, -(part.value?.byteLength ?? 0), 0)).commit();
        if (!commit.ok) {
          result.conflicts++;
          result.truncated = true;
          return;
        }
        result.deleted++;
      } catch (error) {
        const removed = await inspect(error, async () => {
          const current = await this.#db.get(part.key);
          if (current.value === null && current.versionstamp === null) return true;
          if (current.value === null || current.versionstamp === null) {
            throw lost(path, "Part ownership is inconsistent.");
          }
          return false;
        });
        if (removed) result.deleted++;
        else throw error;
      }
    }
    const state = await this.#state(path, generation);
    if (state.value!.state === "reclaiming" && state.value!.claim === claim) {
      await this.#db.atomic().check(state).set(state.key, {
        ...state.value!,
        state: "reclaimed",
        reclaimedAt: this.#now(),
      }).commit();
    }
  }

  async collect(options: GenerationCollectOptionsType): Promise<GenerationCollectResultType> {
    throwIfAborted(options.signal, "collect");
    const cursor = options.cursor === undefined
      ? undefined
      : z.tuple([z.string(), z.string(), z.boolean()]).parse(JSON.parse(options.cursor));
    await this.open();
    const result: GenerationCollectResultType = {
      generations: 0,
      parts: 0,
      deleted: 0,
      retained: 0,
      truncated: false,
      active: 0,
      pinned: 0,
      conflicts: 0,
      scanned: 0,
      prunedPins: 0,
    };
    let pinScans = 0;
    for (const pending of this.#pending.values()) {
      throwIfAborted(options.signal, "collect");
      if (!pending.uncertain) continue;
      if (pinScans >= options.maxPinScans) {
        result.truncated = true;
        break;
      }
      pinScans++;
      await this.#release(pending.path, pending.generation, pending.key, pending.token);
      this.#pending.delete(pending.token);
    }
    const selector = cursor === undefined ? { prefix: [this.#prefix, "generation"] } : {
      prefix: [this.#prefix, "generation"],
      start: cursor[2]
        ? [this.#prefix, "generation", cursor[0], cursor[1]]
        : [this.#prefix, "generation", cursor[0], cursor[1], ""],
    };
    for await (const listed of this.#db.list(selector)) {
      if (result.scanned >= options.maxScans || result.deleted >= options.maxDeletes) {
        result.truncated = true;
        break;
      }
      throwIfAborted(options.signal, "collect");
      result.scanned++;
      result.generations++;
      let state = { ...listed, value: GenerationSchema.parse(listed.value) };
      const { path, generation } = state.value;
      result.cursor = JSON.stringify([path, generation, true]);
      const completed = () => {
        result.cursor = JSON.stringify([path, generation, false]);
      };
      if (
        state.value.state === "published" || (state.value.state === "writing" && state.value.deadline > this.#now()) ||
        (state.value.state === "retired" && (state.value.retiredAt ?? this.#now()) > this.#now() - options.minAgeMs)
      ) {
        result.active++;
        result.retained++;
        completed();
        continue;
      }
      if (state.value.state === "reclaimed") {
        if ((state.value.reclaimedAt ?? this.#now()) <= this.#now() - options.tombstoneAgeMs) {
          const usage = await this.#usage();
          try {
            await this.#db.atomic().check(state, usage).delete(state.key)
              .set(usage.key, this.#capacity(usage.value!, 0, -1)).commit();
          } catch (error) {
            const removed = await inspect(error, async () => {
              const current = await this.#db.get(state.key);
              if (current.value === null && current.versionstamp === null) return true;
              if (current.value === null || current.versionstamp === null) {
                throw lost(path, "Generation ownership is inconsistent.");
              }
              return false;
            });
            if (!removed) throw error;
          }
        }
        completed();
        continue;
      }
      let complete = true;
      for await (const pin of this.#db.list<PinType>({ prefix: this.#pins(path, generation) })) {
        if (pinScans >= options.maxPinScans || result.scanned >= options.maxScans) {
          complete = false;
          result.truncated = true;
          break;
        }
        pinScans++;
        result.scanned++;
        const value = PinSchema.parse(pin.value);
        if (value.deadline > this.#now()) {
          result.pinned++;
          complete = false;
          break;
        }
        if (await this.#release(path, generation, pin.key, value.token, this.#now())) result.prunedPins++;
      }
      if (!complete) {
        if (result.truncated) break;
        completed();
        continue;
      }
      state = await this.#state(path, generation) as DenoKvEntryType<GenerationType> & { value: GenerationType };
      if (state.value.pins !== 0) {
        result.conflicts++;
        completed();
        continue;
      }
      // Recheck eligibility after pruning/renewal. The claim CAS below, not the
      // age scan, excludes late prepared writers and reader renewals.
      if (
        state.value.state === "published" || (state.value.state === "writing" && state.value.deadline > this.#now()) ||
        (state.value.state === "retired" && (state.value.retiredAt ?? this.#now()) > this.#now() - options.minAgeMs)
      ) {
        result.active++;
        completed();
        continue;
      }
      const claim = crypto.randomUUID();
      const committed = await this.#db.atomic().check(state).set(state.key, {
        ...state.value,
        state: "reclaiming",
        claim,
      }).commit();
      if (!committed.ok) {
        result.conflicts++;
        completed();
        continue;
      }
      await this.#reclaim(path, generation, claim, options, result);
      if (result.truncated) break;
      completed();
    }
    throwIfAborted(options.signal, "collect");
    if (!result.truncated) delete result.cursor;
    return result;
  }
}
