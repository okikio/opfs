import { openFileSystem, probeOpfs } from "../../../mod.ts";
import { within } from "../../gate.ts";

/** Exercises byte semantics against real OPFS rather than memory handle doubles. */
export async function bytes() {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return { supported: false, probe };
  const fileSystem = await openFileSystem();
  const root = `/bytes-${crypto.randomUUID()}`;
  const path = `${root}/零 space.bin`;
  try {
    await fileSystem.writeFile(path, new Uint8Array([0, 1, 127, 255]), { parents: true });
    await fileSystem.writeFile(path, new Uint8Array([8, 9]), { mode: "append" });
    await fileSystem.writeFile(path, new Uint8Array([42]), { mode: "update", at: 2 });
    const value = Array.from(await fileSystem.readFile(path));
    const range = Array.from(await fileSystem.readFile(path, { at: 1, length: 3 }));
    const empty = Array.from(await fileSystem.readFile(path, { at: 2, length: 0 }));
    const stream = await fileSystem.openReadStream(path, { at: 3, length: 2 });
    const streamed = Array.from(new Uint8Array(await new Response(stream).arrayBuffer()));
    await fileSystem.copy(path, `${root}/copy.bin`);
    await fileSystem.move(`${root}/copy.bin`, `${root}/moved.bin`);
    const moved = Array.from(await fileSystem.readFile(`${root}/moved.bin`));
    const names = [];
    for await (const entry of fileSystem.readDir(root)) names.push(entry.name);
    return { supported: true, value, range, empty, streamed, moved, names: names.sort() };
  } finally {
    try {
      await fileSystem.remove(root, { recursive: true });
    } finally {
      await fileSystem.close();
    }
  }
}

/** A rejected producer cannot publish a partial replacement or retain a mutation lock. */
export async function failure() {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return { supported: false, probe };
  const fileSystem = await openFileSystem();
  const path = `/failure-${crypto.randomUUID()}.bin`;
  let cancelled = 0;
  const controller = new AbortController();
  let pendingController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let write: Promise<void> | undefined;
  try {
    await fileSystem.writeFile(path, "original");
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.error(new Error("producer-failure"));
      },
    });
    let error = "";
    try {
      await fileSystem.writeFile(path, source);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const preserved = await fileSystem.readText(path);
    let signalRead!: () => void;
    const reading = new Promise<void>((resolve) => signalRead = resolve);
    const pending = new ReadableStream<Uint8Array>({
      start(source) {
        pendingController = source;
      },
      pull() {
        signalRead();
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled += 1;
      },
    }, { highWaterMark: 0 });
    write = fileSystem.writeFile(path, pending, { signal: controller.signal });
    void write.catch(() => {});
    await within(reading, "browser stalled producer begins");
    controller.abort(new DOMException("cancel pending producer", "AbortError"));
    let code = "";
    try {
      await within(write, "browser stalled producer abort");
    } catch (failure) {
      code = String(Reflect.get(Object(failure), "code"));
    }
    const aborted = await fileSystem.readText(path);
    await fileSystem.writeFile(path, "recovered");
    return { supported: true, error, preserved, code, cancelled, aborted, recovered: await fileSystem.readText(path) };
  } finally {
    controller.abort("browser fixture cleanup");
    try {
      pendingController?.close();
    } catch { /* Cancellation already closed the stream. */ }
    if (write !== undefined) await within(Promise.allSettled([write]), "browser stalled writer cleanup");
    try {
      await fileSystem.remove(path);
    } finally {
      await fileSystem.close();
    }
  }
}

/** Shares one origin's durable bytes across distinct page-owned filesystem instances. */
export async function write(path: string, value: string) {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return false;
  const fileSystem = await openFileSystem();
  try {
    await fileSystem.writeFile(path, value, { parents: true });
    return true;
  } finally {
    await fileSystem.close();
  }
}

/** Installs only test capabilities; production imports acquire no storage. */
export const reliability = { bytes, failure, write };
