/** Explicit Node crypto capability for the age v1 payload reader. @module */
import { isBytes, toView } from "../bytes.ts";
import type { SourceReadOptionsType } from "../source.ts";
import { AgeError } from "./age.ts";
import type { AgeAeadType } from "./age.ts";

/** Borrowed native cipher instance. Authentication must succeed in final(). */
export interface AgeNodeDecipherType {
  setAuthTag(tag: Uint8Array<ArrayBuffer>): unknown;
  update(bytes: Uint8Array<ArrayBuffer>): Uint8Array;
  final(): Uint8Array;
}
/**
 * Pass the node:crypto module explicitly. This module never imports or discovers
 * Node crypto. Availability of chacha20-poly1305 depends on the supplied build.
 */
export interface AgeNodeCryptoType {
  createDecipheriv(
    algorithm: "chacha20-poly1305",
    key: Uint8Array<ArrayBuffer>,
    nonce: Uint8Array<ArrayBuffer>,
    options: { authTagLength: 16 },
  ): AgeNodeDecipherType;
}
/** Copies the intrinsic byte range before any later foreign capability call. */
function copy(value: unknown, min: number, max: number, label: string): Uint8Array<ArrayBuffer> {
  if (!isBytes(value)) throw new TypeError(`${label} requires native bytes.`);
  const view = toView(value);
  if (view.byteLength < min || view.byteLength > max) throw new RangeError(`${label} has an unsupported extent.`);
  return new Uint8Array(view);
}
/**
 * Create a bounded IETF ChaCha20-Poly1305 provider for one age payload unit.
 *
 * The key, nonce and sealed bytes are copied before reading the signal or calling
 * native crypto. update() may yield unauthenticated plaintext; it stays private
 * until final() succeeds. Returned bytes belong to the caller. Owned scratch is
 * cleared best-effort, which cannot erase native, JIT or garbage collector copies.
 * In addition to reader-owned work, this factory retains up to sealed.length +
 * 2 * plaintext.length + 44 private bytes per call (including returned output).
 * Native cipher allocation and provider-returned temporary buffers are opaque
 * and are not covered by that allocation-unit bound or the reader's plan().
 * Cancellation is checked between synchronous native calls; it cannot interrupt
 * an active native call. No cipher fallback or key discovery occurs.
 */
export function createNodeAgeAead(crypto: AgeNodeCryptoType): AgeAeadType {
  const create = crypto.createDecipheriv.bind(crypto);
  return Object.freeze({
    async decrypt(
      keyInput: Uint8Array<ArrayBuffer>,
      nonceInput: Uint8Array<ArrayBuffer>,
      sealedInput: Uint8Array<ArrayBuffer>,
      options: SourceReadOptionsType = {},
    ): Promise<Uint8Array> {
      const key = copy(keyInput, 32, 32, "Age payload key");
      let nonce: Uint8Array<ArrayBuffer> | undefined;
      let sealed: Uint8Array<ArrayBuffer> | undefined;
      let tentative: Uint8Array<ArrayBuffer> | undefined;
      let tail: Uint8Array<ArrayBuffer> | undefined;
      let output: Uint8Array<ArrayBuffer> | undefined;
      let success = false;
      try {
        nonce = copy(nonceInput, 12, 12, "Age payload nonce");
        sealed = copy(sealedInput, 16, 65552, "Age sealed payload unit");
        const signal = options.signal;
        const alive = (): void => {
          signal?.throwIfAborted();
        };
        alive();
        const decipher = create("chacha20-poly1305", key, nonce, { authTagLength: 16 });
        alive();
        // Capture all methods before tentative plaintext exists. The supplied
        // native capability owns authentication; this adapter owns its copies.
        const setTag = decipher.setAuthTag.bind(decipher);
        const update = decipher.update.bind(decipher);
        const final = decipher.final.bind(decipher);
        alive();
        setTag(sealed.subarray(sealed.length - 16));
        alive();
        const length = sealed.length - 16;
        tentative = copy(update(sealed.subarray(0, length)), 0, length, "Age native tentative plaintext");
        alive();
        let finalBytes: Uint8Array;
        try {
          finalBytes = final();
        } catch {
          throw new AgeError(
            "authentication",
            "Age payload authentication was not established at native finalization.",
          );
        }
        tail = copy(finalBytes, length - tentative.length, length - tentative.length, "Age native final plaintext");
        alive();
        output = new Uint8Array(length);
        output.set(tentative);
        output.set(tail, tentative.length);
        alive();
        success = true;
        return output;
      } finally {
        key.fill(0);
        nonce?.fill(0);
        sealed?.fill(0);
        tentative?.fill(0);
        tail?.fill(0);
        if (!success) output?.fill(0);
      }
    },
  });
}
