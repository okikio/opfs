/**
 * Block blob helpers for the Azure Blob client.
 *
 * These helpers cut a stream into blocks, plan server-side copy blocks, and build
 * block IDs and the Put Block List body.
 *
 * @module
 */
import { AZURE_LIMITS } from "./limits.ts";
import type { AzureBlockSourceType, AzureCopyBlockType } from "./types.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { open } from "../../chunk.ts";
import { toByteStream } from "../../stream.ts";
import { createXmlElement, createXmlText, stringifyXml } from "../../xml.ts";

/** Default streamed block size, small enough for broad emulator/provider support. */
export const DEFAULT_BLOCK_SIZE = 8 * 1024 * 1024;

/** Creates a cryptographic attempt identity; part retries retain their original ID. */
export function getBlockId(session: Uint8Array, index: number): string {
  const id = new Uint8Array(18);
  id.set(session);
  new DataView(id.buffer).setUint16(16, index);
  return encodeBase64(id);
}

/** Builds the XML document that commits one ordered Azure block list. */
export function getBlockListBody(ids: readonly string[]): string {
  return stringifyXml(createXmlElement(
    "BlockList",
    ids.map((id) => createXmlElement("Latest", [createXmlText(id)])),
  ));
}

/** Converts one materialized byte array into a single-use Web stream. */
export function getByteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return toByteStream(bytes);
}

/** Assigns stable ordered IDs while owning the byte reader and its cleanup. */
export function getBlocks(
  source: ReadableStream<Uint8Array>,
  size: number,
  signal?: AbortSignal,
): AzureBlockSourceType {
  const session = crypto.getRandomValues(new Uint8Array(16));
  const chunks = open(source, size, signal);
  let number = 0;
  return {
    async next() {
      const result = await chunks.next();
      if (result.done) return { done: true, value: undefined };
      number += 1;
      if (number > AZURE_LIMITS.maxCommittedBlocks) {
        throw new RangeError(`Azure block upload exceeds the ${AZURE_LIMITS.maxCommittedBlocks}-block service limit.`);
      }
      return { done: false, value: { number, id: getBlockId(session, number), bytes: result.value } };
    },
    async return() {
      await chunks.return?.();
      return { done: true, value: undefined };
    },
    interrupt: () => chunks.interrupt(),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** Generates server-side source ranges without allocating the source object. */
export function* getCopyBlocks(size: number, blockSize: number): IterableIterator<AzureCopyBlockType> {
  const session = crypto.getRandomValues(new Uint8Array(16));
  let number = 0;
  for (let start = 0; start < size; start += blockSize) {
    number += 1;
    yield {
      number,
      id: getBlockId(session, number),
      start,
      end: Math.min(size, start + blockSize) - 1,
    };
  }
}
