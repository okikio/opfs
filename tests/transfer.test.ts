import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { cancelTransfer, createTransferCheckpoint, resumeTransfer, TransferCheckpointSchema } from "../src/transfer.ts";
import type { TransferCheckpointType, UploadDestinationType } from "../src/transfer.ts";

/** In-memory replay source and exclusively owned destination with observable effects. */
function fixture() {
  const input = new Uint8Array([1, 2, 3, 4, 5]);
  const output: number[] = [];
  const reads: number[][] = [];
  const source = {
    size: input.length,
    identity: "immutable-fixture-v1",
    async read(offset: number, length: number) {
      reads.push([offset, length]);
      return input.slice(offset, offset + length);
    },
  };
  const destination: UploadDestinationType = {
    protocol: "test-upload-v1",
    url: "https://upload.example/owned-session",
    async status() {
      return { offset: output.length, size: input.length, complete: output.length === input.length };
    },
    async write(offset, bytes) {
      expect(offset).toBe(output.length);
      output.push(...bytes);
      return output.length;
    },
  };
  return { source, destination, reads, output };
}

describe("checkpoint-resumable transfer", () => {
  it("admits native source extents without invoking shadowed metadata", async () => {
    const { source, destination, output } = fixture();
    const short = new Uint8Array(1);
    Object.defineProperty(short, "byteLength", { value: source.size });
    await expect(resumeTransfer({
      source: {
        ...source,
        async read() {
          return short;
        },
      },
      destination,
      checkpoint: createTransferCheckpoint(source, destination),
      async save() {},
    })).rejects.toMatchObject({ code: "source" });
    expect(output).toEqual([]);
    let getters = 0;
    const result = await resumeTransfer({
      source: {
        ...source,
        async read(offset: number, length: number) {
          const bytes = await source.read(offset, length);
          for (const name of ["byteLength", "byteOffset", "buffer", "length"]) {
            Object.defineProperty(bytes, name, {
              get() {
                getters++;
                throw new Error("Unexpected caller metadata access.");
              },
            });
          }
          return bytes;
        },
      },
      destination,
      checkpoint: createTransferCheckpoint(source, destination),
      async save() {},
    });
    expect(result.state).toBe("completed");
    expect(output).toEqual([1, 2, 3, 4, 5]);
    expect(getters).toBe(0);
  });
  it("accepts genuine native bytes from another realm", async () => {
    const bytes: Uint8Array = runInNewContext("new Uint8Array([7])");
    const output: number[] = [];
    const source = {
      size: 1,
      identity: "cross-realm-v1",
      async read() {
        return bytes;
      },
    };
    const destination: UploadDestinationType = {
      protocol: "test-v1",
      url: "https://upload.example/cross-realm",
      async status() {
        return { size: 1, offset: output.length, complete: output.length === 1 };
      },
      async write(_offset, chunk) {
        output.push(...chunk);
        return output.length;
      },
    };
    const result = await resumeTransfer({
      source,
      destination,
      checkpoint: createTransferCheckpoint(source, destination),
      async save() {},
    });
    expect(result.state).toBe("completed");
    expect(output).toEqual([7]);
  });
  it("uses bounded exact reads and saves only acknowledged offsets", async () => {
    const { source, destination, reads, output } = fixture();
    const checkpoints: TransferCheckpointType[] = [];
    const result = await resumeTransfer({
      source,
      destination,
      checkpoint: createTransferCheckpoint(source, destination),
      chunkBytes: 2,
      async save(value) {
        expect(value.offset).toBe(output.length);
        checkpoints.push(value);
      },
    });
    expect(result.state).toBe("completed");
    expect(output).toEqual([1, 2, 3, 4, 5]);
    expect(reads).toEqual([[0, 2], [2, 2], [4, 1]]);
    expect(checkpoints.map((entry) => entry.offset)).toEqual([0, 2, 4, 5, 5]);
  });

  it("reconciles bytes acknowledged before a checkpoint save failed", async () => {
    const { source, destination, reads, output } = fixture();
    let saved = createTransferCheckpoint(source, destination);
    const failure = new Error("disk checkpoint write failed");
    await expect(resumeTransfer({
      source,
      destination,
      checkpoint: saved,
      chunkBytes: 2,
      async save(value) {
        if (value.offset === 2) throw failure;
        saved = value;
      },
    })).rejects.toBe(failure);
    expect(saved.offset).toBe(0);
    expect(output).toEqual([1, 2]);
    const result = await resumeTransfer({
      source,
      destination,
      checkpoint: saved,
      chunkBytes: 2,
      async save(value) {
        saved = value;
      },
    });
    expect(result.state).toBe("completed");
    expect(output).toEqual([1, 2, 3, 4, 5]);
    expect(reads).toEqual([[0, 2], [2, 2], [4, 1]]);
  });

  it("pauses between acknowledged chunks and resumes without deleting remote state", async () => {
    const { source, destination, output } = fixture();
    let saved = createTransferCheckpoint(source, destination);
    const options = {
      source,
      destination,
      checkpoint: saved,
      chunkBytes: 2,
      async save(value: TransferCheckpointType) {
        saved = value;
      },
    };
    const paused = await resumeTransfer({ ...options, pause: () => output.length >= 2 });
    expect(paused).toMatchObject({ state: "paused", offset: 2 });
    const result = await resumeTransfer({ ...options, checkpoint: saved });
    expect(result).toMatchObject({ state: "completed", offset: 5 });
  });

  it("refuses source/destination changes and cancelled state before effects", async () => {
    const { source, destination } = fixture();
    const checkpoint = createTransferCheckpoint(source, destination);
    let requests = 0;
    const observed = {
      ...destination,
      async status() {
        requests++;
        return { offset: 0, size: 5, complete: false };
      },
    };
    for (
      const altered of [
        { ...checkpoint, source: "changed" },
        { ...checkpoint, size: 6 },
        { ...checkpoint, destination: "https://other.example/session" },
        { ...checkpoint, protocol: "other" },
        { ...checkpoint, state: "cancelled" as const },
      ]
    ) {
      await expect(resumeTransfer({ source, destination: observed, checkpoint: altered, async save() {} })).rejects
        .toThrow();
    }
    expect(requests).toBe(0);
  });

  it("refuses remote rollback or overrun without reading source bytes", async () => {
    const { source, destination, reads } = fixture();
    const checkpoint = { ...createTransferCheckpoint(source, destination), offset: 2 };
    for (const offset of [1, 6, NaN]) {
      await expect(resumeTransfer({
        source,
        destination: {
          ...destination,
          async status() {
            return { offset, size: 5, complete: false };
          },
        },
        checkpoint,
        async save() {},
      })).rejects.toMatchObject({ code: "offset" });
    }
    expect(reads).toEqual([]);
  });

  it("stops on abort and leaves the last acknowledged checkpoint resumable", async () => {
    const { source, destination, output } = fixture();
    const controller = new AbortController();
    const failure = new Error("user paused application");
    let saved = createTransferCheckpoint(source, destination);
    await expect(
      resumeTransfer({
        source,
        destination,
        checkpoint: saved,
        chunkBytes: 2,
        signal: controller.signal,
        async save(value) {
          saved = value;
          if (value.offset === 2) controller.abort(failure);
        },
      }),
    ).rejects.toBe(failure);
    expect(saved.offset).toBe(2);
    expect(output).toEqual([1, 2]);
  });

  it("rejects truncated reads and mismatched acknowledgments without advancing a checkpoint", async () => {
    const { source, destination, output } = fixture();
    let saved = createTransferCheckpoint(source, destination);
    await expect(resumeTransfer({
      source: {
        ...source,
        async read() {
          return new Uint8Array(0);
        },
      },
      destination,
      checkpoint: saved,
      async save(value) {
        saved = value;
      },
    })).rejects.toMatchObject({ code: "source" });
    expect(output).toEqual([]);
    expect(saved.offset).toBe(0);
    await expect(resumeTransfer({
      source,
      destination: {
        ...destination,
        async write() {
          return 1;
        },
      },
      checkpoint: saved,
      async save(value) {
        saved = value;
      },
    })).rejects.toMatchObject({ code: "offset" });
    expect(saved.offset).toBe(0);
  });

  it("cancels remotely only when requested and saves cancellation after acknowledgment", async () => {
    const { source, destination } = fixture();
    let removed = false;
    const cancellable = {
      ...destination,
      async terminate() {
        removed = true;
      },
    };
    const result = await cancelTransfer(
      cancellable,
      createTransferCheckpoint(source, destination),
      async (checkpoint) => {
        expect(removed).toBe(true);
        expect(checkpoint.state).toBe("cancelled");
      },
    );
    expect(result.state).toBe("cancelled");
  });

  it("rejects unknown persisted fields and incomplete completed records", () => {
    const { source, destination } = fixture();
    const checkpoint = createTransferCheckpoint(source, destination);
    expect(TransferCheckpointSchema.safeParse({ ...checkpoint, secret: "no" }).success).toBe(false);
    expect(TransferCheckpointSchema.safeParse({ ...checkpoint, state: "completed" }).success).toBe(false);
  });

  it("does not call staged bytes completed before a final publication receipt", async () => {
    const { source, destination, output } = fixture();
    const snapshots: TransferCheckpointType[] = [];
    const staged = {
      ...destination,
      async status() {
        return { offset: output.length, size: source.size, complete: false };
      },
    };
    await expect(
      resumeTransfer({
        source,
        destination: staged,
        checkpoint: createTransferCheckpoint(source, staged),
        async save(value) {
          snapshots.push(value);
        },
      }),
    ).rejects.toMatchObject({ code: "state" });
    expect(output).toEqual([1, 2, 3, 4, 5]);
    expect(snapshots.at(-1)).toMatchObject({ offset: 5, state: "active" });
    expect(snapshots.some((entry) => entry.state === "completed")).toBe(false);
    let published = false;
    const publishable = {
      ...staged,
      async finish() {
        published = true;
        return { offset: source.size, size: source.size, complete: true };
      },
    };
    const result = await resumeTransfer({
      source,
      destination: publishable,
      checkpoint: snapshots.at(-1)!,
      async save(value) {
        if (value.state === "completed") expect(published).toBe(true);
      },
    });
    expect(result.state).toBe("completed");
  });

  it("requires publication of an empty source instead of treating zero staged bytes as completion", async () => {
    let finished = 0;
    const source = {
      identity: "empty-v1",
      size: 0,
      async read() {
        throw new Error("Empty input must not be acquired.");
      },
    };
    const destination: UploadDestinationType = {
      protocol: "staged-v1",
      url: "https://upload.example/empty",
      async status() {
        return { offset: 0, size: 0, complete: false };
      },
      async write() {
        throw new Error("Empty input must not be written.");
      },
      async finish() {
        finished++;
        return { offset: 0, size: 0, complete: true };
      },
    };
    const result = await resumeTransfer({
      source,
      destination,
      checkpoint: createTransferCheckpoint(source, destination),
      async save() {},
    });
    expect(result.state).toBe("completed");
    expect(finished).toBe(1);
  });
});
