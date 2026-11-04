import { openFileSystem, probeOpfs } from "../../../mod.ts";
import { within } from "../../gate.ts";
import { withReleases } from "../../close.ts";

/** Exercises byte semantics against real OPFS rather than memory handle doubles. */
export async function bytes() {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return { supported: false, probe };
  return await withReleases(async (releases) => {
    const fileSystem = await openFileSystem();
    releases.push(() => fileSystem.close());
    const root = `/bytes-${crypto.randomUUID()}`;
    releases.push(() => fileSystem.remove(root, { recursive: true }));
    const path = `${root}/零 space.bin`;
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
  });
}

/** A rejected producer cannot publish a partial replacement or retain a mutation lock. */
export async function failure() {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return { supported: false, probe };
  return await withReleases(async (releases) => {
    const fileSystem = await openFileSystem();
    releases.push(() => fileSystem.close());
    const path = `/failure-${crypto.randomUUID()}.bin`;
    releases.push(() => fileSystem.remove(path));
    let cancelled = 0;
    const controller = new AbortController();
    let pendingController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const writer: { pending?: Promise<void> } = {};
    // Reverse release order aborts the producer, settles its owned controller,
    // joins the admitted writer, then removes only this fixture's path and closes.
    releases.push(async () => {
      if (writer.pending !== undefined) {
        await within(Promise.allSettled([writer.pending]), "browser stalled writer cleanup");
      }
    });
    releases.push(() => {
      try {
        pendingController?.close();
      } catch { /* Cancellation already closed the stream. */ }
    });
    releases.push(() => controller.abort("browser fixture cleanup"));
    await fileSystem.writeFile(path, "original");
    let pulls = 0;
    const producerFailure = new Error("producer-failure");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.error(producerFailure);
      },
    });
    let sourcePreserved = false;
    try {
      await fileSystem.writeFile(path, source);
    } catch (failure) {
      sourcePreserved = failure === producerFailure || Reflect.get(Object(failure), "cause") === producerFailure;
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
    const write = writer.pending = fileSystem.writeFile(path, pending, { signal: controller.signal });
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
    return {
      supported: true,
      sourcePreserved,
      preserved,
      code,
      cancelled,
      aborted,
      recovered: await fileSystem.readText(path),
    };
  });
}

/** Shares one origin's durable bytes across distinct page-owned filesystem instances. */
export async function write(path: string, value: string) {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) return false;
  return await withReleases(async (releases) => {
    const fileSystem = await openFileSystem();
    releases.push(() => fileSystem.close());
    await fileSystem.writeFile(path, value, { parents: true });
    return true;
  });
}

/** Installs only test capabilities; production imports acquire no storage. */
export const reliability = { bytes, failure, write };
