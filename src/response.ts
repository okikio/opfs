import { isBytes } from "./bytes.ts";
import { openBytes } from "./stream.ts";
import { aggregate } from "./close.ts";

/** Awaitable whole-text capability bound to one internally owned response. */
export type ResponseTextType = () => PromiseLike<string>;

/** One terminal result, including an actual rejection with null or undefined. */
type ResponseOutcomeType<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: unknown };

/** Actual body settlement and delivery belong to this reader, not error identity. */
interface ResponseReadType {
  terminal: boolean;
  readonly cleanup: unknown[];
  read?: {
    readonly result: Promise<ResponseOutcomeType<string>>;
    readonly delivery: { observed: boolean };
  };
}

/** Throws every independently observed fault without replacing the first cause. */
function fail(reasons: readonly unknown[]): void {
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1) {
    throw aggregate(reasons, "Response reading and release failed.");
  }
}

/**
 * Owns one native reader until EOF, a stream error, or awaited cancellation.
 *
 * Fetch text uses UTF-8 replacement decoding and removes an initial BOM.
 * Incremental decoding preserves BOMs, then this owner removes exactly one
 * leading decoded BOM. This keeps empty-chunk and split-BOM behavior consistent
 * across supported runtimes while preserving later BOMs. Native
 * reader settlement proves terminal consumption even when Response.text() fails
 * before a runtime marks bodyUsed. Conversion failure is not stream settlement:
 * cancel the still-readable source, then release the acquired lock. An unused
 * header response never enters this materializing path. Like Response.text(),
 * this returns the complete text and does not introduce a payload-size policy.
 */
async function readBody(response: Response, state: ResponseReadType): Promise<string> {
  const body = response.body;
  if (body === null) {
    state.terminal = true;
    return "";
  }
  if (response.bodyUsed) throw new TypeError("The response body was already used.");
  // A failed acquisition does not give us ownership of someone else's reader.
  const reader = openBytes(body);
  let failure: { readonly reason: unknown } | undefined;
  let text = "";
  try {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (reason) {
        state.terminal = true;
        throw reason;
      }
      if (chunk.done) {
        state.terminal = true;
        break;
      }
      if (!isBytes(chunk.value)) {
        throw new TypeError("A response body chunk must be a Uint8Array.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (reason) {
    failure = { reason };
  }
  if (!state.terminal) {
    try {
      await reader.cancel();
    } catch (reason) {
      state.cleanup.push(reason);
    }
    // Cancellation has actually settled, including an independently failed
    // source cleanup. That failure is retained and must not be requested twice.
    state.terminal = true;
  }
  try {
    reader.releaseLock();
  } catch (reason) {
    state.cleanup.push(reason);
  }
  if (failure !== undefined) throw failure.reason;
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Reads standalone XML/error text with the same explicit reader lifetime. */
export async function readText(response: Response): Promise<string> {
  const state: ResponseReadType = { terminal: false, cleanup: [] };
  let outcome: ResponseOutcomeType<string>;
  try {
    outcome = { ok: true, value: await readBody(response, state) };
  } catch (reason) {
    outcome = { ok: false, reason };
  }
  fail([...(outcome.ok ? [] : [outcome.reason]), ...state.cleanup]);
  if (!outcome.ok) throw outcome.reason;
  return outcome.value;
}

/**
 * Reads an internally retained response and retires its unused body before return.
 *
 * Callbacks read headers or await the supplied text capability. They do not leave
 * a partial reader. This owner drains every text read that a callback starts,
 * including one ignored before early callback failure. The minimal awaitable
 * records delivery of that exact read rejection to the callback. A classified
 * delivered read fault is not reported twice; an undelivered read fault remains
 * independent even when it is the same object as the callback failure.
 *
 * Header acknowledgements and accepted missing-object responses cancel unused
 * bodies instead of materializing them. Actual reader EOF/error/cancel settlement
 * certifies terminal consumption; bodyUsed alone cannot certify partial-reader
 * completion. A transferred, disturbed body with its reader released is still
 * cancelled. A borrowed lock is left untouched and prevents a header-only
 * operation from reporting successful retirement. Raw request responses and successful get streams transfer to the
 * caller and do not use this owner. Publication classification belongs inside
 * the callback; later disposal failure cannot invent an unknown outcome.
 */
export async function readResponse<Value>(
  response: Response,
  read: (text: ResponseTextType) => Value | PromiseLike<Value>,
): Promise<Value> {
  const state: ResponseReadType = { terminal: false, cleanup: [] };
  const text: ResponseTextType = () => {
    if (state.read !== undefined) throw new TypeError("The owned response text reader was already started.");
    const pending = readBody(response, state);
    const delivery = { observed: false };
    // Attach both terminal handlers immediately, even when the callback ignores
    // the returned awaitable. The owner drains this result without an unhandled
    // rejection or a promise that can lose a late read fault.
    const result: Promise<ResponseOutcomeType<string>> = pending.then(
      (value) => ({ ok: true, value }),
      (reason: unknown) => ({ ok: false, reason }),
    );
    state.read = { result, delivery };
    return {
      then(onfulfilled, onrejected) {
        return pending.then(onfulfilled, (reason: unknown) => {
          if (onrejected !== undefined && onrejected !== null) {
            delivery.observed = true;
            return onrejected(reason);
          }
          throw reason;
        });
      },
    };
  };
  let outcome: ResponseOutcomeType<Value>;
  try {
    outcome = { ok: true, value: await read(text) };
  } catch (reason) {
    outcome = { ok: false, reason };
  }
  const failures: unknown[] = outcome.ok ? [] : [outcome.reason];
  const started = state.read;
  // Only delivery before the callback settles can classify that callback's
  // outcome. A detached late rejection handler cannot turn an early header
  // acknowledgement into successful ownership of an unread failed body.
  const delivered = started?.delivery.observed ?? false;
  if (started !== undefined) {
    const result = await started.result;
    if (!result.ok && !delivered) failures.push(result.reason);
  }
  // Parse/classify the delivered text first. A later reader release failure is
  // cleanup, so valid XML acknowledgement cannot become an unknown publication.
  failures.push(...state.cleanup);
  if (!state.terminal && response.body !== null) {
    if (!response.body.locked) {
      // A released partial reader disturbs the body without reaching EOF. The
      // transferred, unlocked body still needs actual cancellation settlement.
      try {
        await response.body.cancel();
      } catch (reason) {
        failures.push(reason);
      }
    } else if (started === undefined || outcome.ok) {
      // We cannot steal an outside reader. A header-only callback has no text
      // acquisition failure to report, and a callback that recovered from that
      // failure still cannot certify retirement. Retain the independent refusal
      // even when header-only acknowledgement processing also failed.
      failures.push(new TypeError("The owned response body has a borrowed reader and cannot be retired."));
    }
  }
  fail(failures);
  if (!outcome.ok) throw outcome.reason;
  return outcome.value;
}
