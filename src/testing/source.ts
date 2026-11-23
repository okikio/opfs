/** Optional extension checks. No test runner or service is loaded on import. @module */
import type { ByteSourceType } from "../source.ts";
import { close } from "../close.ts";
import { isBytes, toView } from "../bytes.ts";

/** Each test acquisition supplies a small independent byte oracle and its cleanup owner. */
export interface SourceFixtureType {
  readonly source: ByteSourceType;
  readonly expected: Uint8Array;
  close(): void | Promise<void>;
}

/** Runs exact-read, independent-byte, extent and pre-abort checks on one extension fixture.
 *
 * This is a small source contract suite, not provider certification. Use a
 * fixture of 1 byte–1 MiB. Factories own initialization and must unwind partial
 * acquisition themselves; after return this function always awaits close.
 * It does not discover services, create credentials or select a test framework.
 */
export async function testByteSource(create: () => SourceFixtureType | Promise<SourceFixtureType>): Promise<void> {
  const fixture = await create();
  const failures: unknown[] = [];
  try {
    const { source } = fixture;
    if (!isBytes(fixture.expected)) throw new TypeError("Source oracle must contain native bytes.");
    const expected = toView(fixture.expected);
    if (expected.byteLength < 1 || expected.byteLength > 1024 * 1024 || source.size !== expected.byteLength) {
      throw new Error("Source conformance requires an independent 1 byte–1 MiB fixture with matching size.");
    }
    for (const [offset, length] of [[0, source.size], [0, 1], [source.size - 1, 1], [source.size, 0]] as const) {
      const bytes = await source.read(offset, length);
      if (!isBytes(bytes)) throw new TypeError("Source returned a non-byte extent.");
      const actual = toView(bytes);
      if (actual.byteLength !== length) throw new Error("Source returned a short extent.");
      for (let index = 0; index < length; index++) {
        if (actual[index] !== expected[offset + index]) throw new Error(`Source bytes differ at ${offset + index}.`);
      }
    }
    for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [source.size, 1]] as const) {
      let refused = false;
      try {
        await source.read(offset, length);
      } catch {
        refused = true;
      }
      if (!refused) throw new Error("Source accepted an invalid extent.");
    }
    const controller = new AbortController();
    const reason = new Error("Source conformance pre-abort");
    controller.abort(reason);
    let observed: unknown;
    try {
      await source.read(0, 1, { signal: controller.signal });
    } catch (error) {
      observed = error;
    }
    if (observed !== reason) throw new Error("Source did not preserve pre-abort authority.");
  } catch (reason) {
    failures.push(reason);
    throw reason;
  } finally {
    await close([() => fixture.close()], failures);
  }
}
