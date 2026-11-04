/** Projection over an acquired iterator retains its actual source and cleanup faults. @module */
import { close } from "./close.ts";

/**
 * Own one acquired iterator while admitting each projected value. The source is
 * returned exactly once on abrupt completion or consumer return; actual EOF
 * does not acquire a return effect. A result getter or projection fault and an
 * independent return failure remain separate observations, including undefined.
 * Checkpoints can stop future effects but cannot preempt a dispatched next().
 */
export async function* project<Value, Result>(
  input: AsyncIterator<Value>,
  select: (value: Value) => Result,
  checkpoint: () => void = () => {},
): AsyncIterableIterator<Result> {
  let finished = false;
  let failure: { reason: unknown } | undefined;
  try {
    const next = input.next;
    checkpoint();
    while (true) {
      checkpoint();
      const result = await next.call(input);
      const done = result.done;
      if (done) finished = true;
      checkpoint();
      if (done) return;
      const value = select(result.value);
      checkpoint();
      yield value;
    }
  } catch (reason) {
    failure = { reason };
  } finally {
    await close(
      finished ? [] : [() => {
        const returning = input.return;
        if (returning !== undefined) return returning.call(input, undefined);
      }],
      failure === undefined ? [] : [failure.reason],
    );
  }
}
