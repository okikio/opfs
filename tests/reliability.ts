import { expect } from "@std/expect";
import type { FileSystemType } from "../src/filesystem.ts";
import { streamBytes } from "./stream.ts";
import { within } from "./gate.ts";
export { within } from "./gate.ts";

/** Owns one fixture facade through its callback and awaits close without losing either failure. */
export async function withFileSystem(
  fileSystem: Pick<FileSystemType, "close">,
  action: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await action();
  } catch (reason) {
    failures.push(reason);
  }
  try {
    await fileSystem.close();
  } catch (reason) {
    failures.push(reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Fixture and owned facade close failed.", { cause: failures[0] });
  }
}

/** Builds reproducible binary fixtures independently of backend serialization. */
export function fixtureBytes(size: number, seed = 17): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 29 + seed) % 251);
}

/** Compares every byte without building a large structural assertion report. */
export function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(actual.findIndex((value, index) => value !== expected[index])).toBe(-1);
}

/**
 * Runs exact byte semantics on native storage and portable fallback routes.
 *
 * The default name protects URL-sensitive punctuation on object/record/browser
 * storage. Native host fixtures supply a name valid on their actual filesystem;
 * that choice changes no byte, range, streaming, append, or copy/move oracle.
 */
export async function verifyBytes(
  fileSystem: FileSystemType,
  prefix = "/bytes",
  filename = "世界 %?#.bin",
): Promise<void> {
  for (const size of [0, 1, 63, 4096, 32767, 32768, 32769, 49151, 49152, 49153, 65535, 65536, 65537, 131089]) {
    const path = `${prefix}/${size}/${filename}`;
    let expected = fixtureBytes(size);
    await fileSystem.writeFile(path, expected, { parents: true });
    expectBytes(await fileSystem.readFile(path), expected);
    expect(await fileSystem.stat(path)).toMatchObject({ kind: "file", size });
    for (const [at, length] of [[0, 0], [0, 7], [7, 0], [7, 65537], [size, 3], [size + 5, 1]] as const) {
      expectBytes(await fileSystem.readFile(path, { at, length }), expected.slice(at, at + length));
      const stream = await fileSystem.openReadStream(path, { at, length });
      expectBytes(new Uint8Array(await new Response(stream).arrayBuffer()), expected.slice(at, at + length));
    }
    const suffix = Uint8Array.of(0, 255, 42);
    await fileSystem.writeFile(path, suffix, { mode: "append" });
    expected = Uint8Array.from([...expected, ...suffix]);
    const position = expected.byteLength + 2;
    await fileSystem.writeFile(path, Uint8Array.of(91, 92), { mode: "update", at: position });
    const expanded = new Uint8Array(position + 2);
    expanded.set(expected);
    expanded.set([91, 92], position);
    expected = expanded;
    expectBytes(await fileSystem.readFile(path), expected);
    await fileSystem.writeFile(path, Uint8Array.of(9, 8), { mode: "update", at: 1, truncate: true });
    expect(await fileSystem.readFile(path)).toEqual(Uint8Array.of(expected[0]!, 9, 8));

    const backing = fixtureBytes(size + 11);
    const view = backing.subarray(5, 5 + size);
    await fileSystem.writeFile(path, streamBytes([view.subarray(0, 1), view.subarray(1, 61), view.subarray(61)]));
    expectBytes(await fileSystem.readFile(path), view);
    await fileSystem.ensureFile(path);
    expectBytes(await fileSystem.readFile(path), view);
    const copied = `${prefix}/${size}/copy.bin`;
    const moved = `${prefix}/${size}/moved.bin`;
    await fileSystem.copy(path, copied);
    expectBytes(await fileSystem.readFile(copied), view);
    await fileSystem.move(copied, moved);
    expect(await fileSystem.exists(copied)).toBe(false);
    expectBytes(await fileSystem.readFile(moved), view);
  }
}

/**
 * Proves native synchronous bytes before overwrite and holds the path lock until close.
 *
 * Completing an independent write provides an observable scheduler barrier while
 * the same-path write waits. Closing in finally also releases the lock when an
 * assertion fails, so teardown cannot hang behind the synchronous owner.
 */
export async function verifySync(fileSystem: FileSystemType, path: string, value: string): Promise<void> {
  const sync = await fileSystem.openSyncFile(path);
  let pending: Promise<void> | undefined;
  try {
    const expected = new TextEncoder().encode(value);
    sync.writeAll(expected, { at: 0 });
    sync.truncate(expected.byteLength);
    sync.truncate(expected.byteLength + 2);
    sync.flush();
    const actual = new Uint8Array(sync.getSize());
    expect(sync.read(actual, { at: 0 })).toBe(actual.byteLength);
    expectBytes(actual, Uint8Array.from([...expected, 0, 0]));
    let completed = false;
    pending = fileSystem.writeFile(path, "after-sync").then(() => {
      completed = true;
    });
    await within(fileSystem.writeFile("/sync-barrier.txt", "barrier"), "independent write while sync file is held");
    expect(completed).toBe(false);
  } finally {
    sync.close();
    if (pending !== undefined) await within(pending, "same-path write after sync close");
  }
  sync.close();
  try {
    sync.getSize();
    throw new Error("Closed synchronous handle remained readable.");
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid-operation" });
  }
  expect(await fileSystem.readText(path)).toBe("after-sync");
}

/** Cancels a native write while its producer is stalled, then proves lock reuse. */
export async function verifyPendingAbort(fileSystem: FileSystemType): Promise<void> {
  const started = Promise.withResolvers<void>();
  const signal = new AbortController();
  let cancellations = 0;
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
    pull() {
      started.resolve();
    },
    cancel() {
      cancellations += 1;
    },
  }, { highWaterMark: 0 });
  const pending = fileSystem.writeFile("/pending-abort.bin", source, { signal: signal.signal });
  const result = pending.then(() => ({ code: "resolved" }), (error: unknown) => error);
  try {
    await within(started.promise, "producer begins reading");
    signal.abort("cancel pending producer");
    const error = await within(result, "pending producer cancellation");
    expect(error).toMatchObject({ code: "aborted" });
    expect(cancellations).toBe(1);
    expect(source.locked).toBe(false);
  } finally {
    signal.abort("test cleanup");
    try {
      sourceController?.close();
    } catch { /* Cancellation already ended the producer. */ }
    await within(result, "pending write cleanup");
  }
  await fileSystem.writeFile("/pending-abort.bin", "recovered");
  expect(await fileSystem.readText("/pending-abort.bin")).toBe("recovered");
}
