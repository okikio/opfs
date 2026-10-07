import { pooledMap } from "@std/async/pool";

/**
 * Maps provider chunks concurrently without discarding the source's terminal error.
 *
 * The upstream pool waits for admitted mapper calls before rejecting. Its error
 * aggregate includes mapper failures, but omits a failure from the input iterator.
 * Capture that input failure at the iterator boundary so a rejected producer or
 * cancelled reader remains the caller's terminal result after uploads drain.
 *
 * A mapper-only failure keeps the upstream aggregate unchanged. When input and
 * mapper failures coexist, the input reason is the cause and first error, followed
 * by independent mapper reasons. No AbortSignal state substitutes for an observed
 * input failure, so cancellation cannot hide an unrelated provider response.
 */
export async function* map<Input, Output>(
  concurrency: number,
  source: Iterable<Input> | AsyncIterable<Input>,
  operation: (input: Input) => Promise<Output>,
): AsyncGenerator<Output> {
  let failure: { readonly reason: unknown } | undefined;
  async function* read(): AsyncGenerator<Input> {
    try {
      yield* source;
    } catch (reason) {
      failure = { reason };
      throw reason;
    }
  }

  try {
    yield* pooledMap(concurrency, read(), operation);
  } catch (error) {
    if (failure === undefined) throw error;
    // The upstream aggregate contains only mapper failures. Equal reason values
    // still describe separate failures, including reused Error objects or undefined.
    const secondary: unknown[] = error instanceof AggregateError
      ? error.errors
      : error === failure.reason
      ? []
      : [error];
    if (secondary.length > 0) {
      throw new AggregateError(
        [failure.reason, ...secondary],
        "The source failed while admitted provider operations also failed.",
        { cause: failure.reason },
      );
    }
    throw failure.reason;
  }
}
