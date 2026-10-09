/**
 * Pull source used by storage tests that need deterministic byte chunks.
 *
 * The source keeps chunk ownership in one named object instead of hiding
 * stream state inside an inline callback. Each pull publishes at most one
 * chunk so multipart tests can choose the exact chunk sequence independently
 * from the provider client's own re-chunking logic.
 */
class ChunkSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Chunks exposed to the test stream in source order. */
  readonly #chunks: readonly Uint8Array[];
  /** Index of the next source chunk. */
  #index = 0;

  /** Creates a finite byte source over caller-owned test chunks. */
  constructor(chunks: readonly Uint8Array[]) {
    this.#chunks = chunks;
  }

  /** Publishes one chunk or closes the stream after the final chunk. */
  pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const chunk = this.#chunks[this.#index];
    this.#index += 1;
    if (chunk === undefined) controller.close();
    else controller.enqueue(chunk);
  }
}

/**
 * Creates a deterministic finite byte stream for storage tests.
 *
 * The function does not merge the supplied chunks. This is useful when a test
 * needs to prove that a client can accept source chunks whose sizes do not
 * match its multipart or block-upload size.
 */
export function streamBytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream(new ChunkSource(chunks));
}

/**
 * Changes a fixture's prototype without inventing native cross-realm support.
 * Some runtimes brand Web interfaces through the original prototype chain.
 * Their intrinsic getter rejects a fully detached copied prototype, so keep
 * that chain after proving the refusal. Other runtimes keep native slots and
 * accept the detached prototype. Neither case uses a duck-typed stream.
 * Actual browser realms are tested separately through browser fixtures.
 */
export function changeStreamPrototype(source: ReadableStream<Uint8Array>, prototype: object): boolean {
  Object.defineProperties(prototype, Object.getOwnPropertyDescriptors(ReadableStream.prototype));
  Object.setPrototypeOf(source, prototype);
  const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")!.get!;
  try {
    locked.call(source);
    return true;
  } catch {
    Object.setPrototypeOf(prototype, ReadableStream.prototype);
    locked.call(source);
    return false;
  }
}
