/** Fixed-layout Azure block continuation. Session descriptors are data; clients and sources remain borrowed. @module */
import { z } from "zod";
import { AzureCommitError, AzureError } from "../azure.ts";
import type { AzureClientType } from "../azure.ts";
import { isBytes, toView } from "../bytes.ts";
import { readResponse } from "../response.ts";
import { createXmlElement, createXmlText, getXmlElements, getXmlScalar, parseXmlRoot, stringifyXml } from "../xml.ts";
import type { UploadDestinationType, UploadRequestOptionsType, UploadStatusType } from "../transfer.ts";

/** Implementation bounds keep remote XML within the shared control-document ceiling and support old service versions. */
export const AZURE_TRANSFER_BLOCKS = 10_000;
/** Four MiB remains legal even before Azure service version 2016-05-31. */
export const AZURE_TRANSFER_BYTES = 4 * 1024 * 1024;
/** Persist atomically before any block write. This descriptor contains no credentials. */
export const AzureSessionSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  backend: z.ZodString;
  key: z.ZodString;
  token: z.ZodString;
  size: z.ZodNumber;
  blockBytes: z.ZodNumber;
  initialETag: z.ZodNullable<z.ZodString>;
  mediaType: z.ZodOptional<z.ZodString>;
}, z.core.$strict> = z.strictObject({
  version: z.literal(1),
  backend: z.string().min(1).max(8192),
  key: z.string().min(1).max(1024),
  token: z.string().regex(/^[A-Za-z0-9_-]{22,40}$/),
  size: z.number().int().nonnegative().max(AZURE_TRANSFER_BLOCKS * AZURE_TRANSFER_BYTES),
  blockBytes: z.number().int().positive().max(AZURE_TRANSFER_BYTES),
  initialETag: z.string().regex(/^"[\x21\x23-\x7e\x80-\xff]*"$/).max(1024).nullable(),
  mediaType: z.string().max(1024).optional(),
}).refine(
  (value) => Math.ceil(value.size / value.blockBytes) <= AZURE_TRANSFER_BLOCKS,
  "Too many Azure continuation blocks.",
);
/** Immutable layout plus destination baseline, independently persisted from acknowledged transfer progress. */
export type AzureSessionType = z.infer<typeof AzureSessionSchema>;
/** The caller supplies a new unpredictable token for each new session and never reuses or copies it. */
export interface AzureSessionOptionsType {
  readonly key: string;
  readonly size: number;
  readonly token: string;
  /** Match resumeTransfer.chunkBytes to this persisted layout. Defaults to 4 MiB. */
  readonly blockBytes?: number;
  readonly mediaType?: string;
  readonly signal?: AbortSignal;
}
/** Validate provider names before even the baseline HEAD; no replacement encoding creates key aliases. */
function name(key: string): void {
  if (new TextEncoder().encode(key).byteLength > 1024) {
    throw new RangeError("Azure continuation key exceeds 1024 bytes.");
  }
  for (const character of key) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError("Azure key contains an unpaired surrogate.");
  }
}
/** Capture a conditional publication baseline; no uncommitted blocks or other remote resources are allocated yet. */
export async function createAzureSession(
  client: AzureClientType,
  options: AzureSessionOptionsType,
): Promise<AzureSessionType> {
  const initial = AzureSessionSchema.parse({
    version: 1,
    backend: client.identity,
    key: options.key,
    token: options.token,
    size: options.size,
    blockBytes: options.blockBytes ?? AZURE_TRANSFER_BYTES,
    initialETag: null,
    ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
  });
  name(initial.key);
  options.signal?.throwIfAborted();
  const previous = await client.head(initial.key, options.signal === undefined ? {} : { signal: options.signal });
  if (previous?.metadata?.opfs_session === initial.token) {
    throw new TypeError("Azure continuation token was already published; do not reuse it.");
  }
  if (previous !== null && previous.etag === undefined) {
    throw new TypeError("Azure baseline needs an enforceable HTTP ETag.");
  }
  return AzureSessionSchema.parse({ ...initial, initialETag: previous?.etag ?? null });
}
/** Fixed-width ASCII IDs obey Azure's equal decoded-length rule without exposing source bytes. */
function blockId(session: AzureSessionType, index: number): string {
  return globalThis.btoa(`${session.token}:${String(index).padStart(5, "0")}`);
}
/** Native error bodies are bounded and retired before a structured provider failure is exposed. */
async function responseText(response: Response, expected: number, operation: string): Promise<string> {
  return await readResponse(response, async (read) => {
    const text = await read();
    if (response.status !== expected) {
      throw new AzureError(`${operation} failed with HTTP ${response.status}.`, response);
    }
    return text;
  });
}
/**
 * Reopen a persisted session with no I/O. Serialize every writer to this key,
 * keep the replay source immutable, and never copy or reuse its token. Azure
 * offers no abort-uncommitted-only operation, so this destination has no
 * terminate(): cancellation does not delete existing or published bytes.
 */
export function createAzureUploadDestination(client: AzureClientType, value: AzureSessionType): UploadDestinationType {
  const session = AzureSessionSchema.parse(value);
  name(session.key);
  if (!client.identity || client.identity !== session.backend) {
    throw new TypeError("Azure session belongs to another backend.");
  }
  const count = Math.ceil(session.size / session.blockBytes);
  const url = `https://opfs.invalid/azure-session/${encodeURIComponent(JSON.stringify(session))}`;
  /** Only unique publication metadata can attribute an ambiguous final commit to this session. */
  async function inspect(options: UploadRequestOptionsType): Promise<UploadStatusType> {
    options.signal?.throwIfAborted();
    const current = await client.head(session.key, options);
    if (current?.metadata?.opfs_session === session.token) {
      if (
        current.size !== session.size || current.metadata.opfs_size !== String(session.size) ||
        current.metadata.opfs_block_bytes !== String(session.blockBytes)
      ) throw new TypeError("Azure session publication has changed layout or extent.");
      return { offset: session.size, size: session.size, complete: true };
    }
    if ((current?.etag ?? null) !== session.initialETag) {
      throw new TypeError("Azure destination changed since this session's baseline.");
    }
    const response = await client.request({
      method: "GET",
      key: session.key,
      query: { comp: "blocklist", blocklisttype: "uncommitted" },
      retry: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 404 && current === null) {
      await readResponse(response, () => undefined);
      return { offset: 0, size: session.size, complete: false };
    }
    const root = parseXmlRoot(await responseText(response, 200, "Get Block List"));
    if (root.name.local !== "BlockList") throw new TypeError("Azure returned another block-list document.");
    const groups = getXmlElements(root, "UncommittedBlocks");
    if (groups.length > 1 || groups.some((group) => !root.children.includes(group))) {
      throw new TypeError("Azure block list has ambiguous groups.");
    }
    const blocks = groups[0] === undefined ? [] : getXmlElements(groups[0], "Block");
    if (
      getXmlElements(root, "Block").length !== blocks.length ||
      root.children.some((child) =>
        child.type === "element" && child.name.local !== "UncommittedBlocks" && child.name.local !== "CommittedBlocks"
      )
    ) {
      throw new TypeError("Azure block list contains misplaced blocks or unknown groups.");
    }
    if (blocks.length > count || blocks.some((block) => !groups[0]!.children.includes(block))) {
      throw new TypeError("Azure block list exceeds this session layout.");
    }
    const retained = new Map<string, number>();
    for (const block of blocks) {
      const id = getXmlScalar(block, "Name");
      const size = getXmlScalar(block, "Size");
      if (retained.has(id) || !/^\d+$/.test(size) || !Number.isSafeInteger(Number(size))) {
        throw new TypeError("Azure returned duplicate or invalid block extents.");
      }
      retained.set(id, Number(size));
    }
    let offset = 0;
    for (let index = 0; index < blocks.length; index++) {
      const id = blockId(session, index);
      const expected = Math.min(session.blockBytes, session.size - offset);
      if (retained.get(id) !== expected) {
        throw new TypeError("Azure retained blocks have gaps, foreign IDs or changed extents.");
      }
      offset += expected;
    }
    return { offset, size: session.size, complete: false };
  }
  return {
    protocol: "azure-blocks-v1",
    url,
    status: (options = {}) => inspect(options),
    async write(offset, bytes, options = {}) {
      if (!isBytes(bytes)) throw new TypeError("Azure continuation needs native byte views.");
      const view = toView(bytes);
      if (
        !Number.isSafeInteger(offset) || offset < 0 || offset >= session.size || offset % session.blockBytes !== 0 ||
        view.byteLength !== Math.min(session.blockBytes, session.size - offset)
      ) throw new RangeError("Azure writes must match the persisted block layout.");
      const owned = new Uint8Array(view);
      const current = await inspect(options);
      if (current.complete || current.offset !== offset) {
        throw new TypeError("Reconcile Azure progress before writing another block.");
      }
      const response = await client.request({
        method: "PUT",
        key: session.key,
        query: { comp: "block", blockid: blockId(session, offset / session.blockBytes) },
        headers: { "content-type": "application/octet-stream" },
        body: owned.buffer,
        retry: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await responseText(response, 201, "Put Block");
      return offset + view.byteLength;
    },
    async finish(options = {}) {
      const current = await inspect(options);
      if (current.complete) return current;
      if (current.offset !== session.size) throw new TypeError("Azure session is not fully staged.");
      const headers = new Headers({
        "content-type": "application/xml",
        "x-ms-meta-opfs_session": session.token,
        "x-ms-meta-opfs_size": String(session.size),
        "x-ms-meta-opfs_block_bytes": String(session.blockBytes),
      });
      headers.set(session.initialETag === null ? "if-none-match" : "if-match", session.initialETag ?? "*");
      if (session.mediaType !== undefined) headers.set("x-ms-blob-content-type", session.mediaType);
      // Uncommitted-only prevents an old committed ID from silently substituting for a missing staged block.
      const body = stringifyXml(
        createXmlElement(
          "BlockList",
          Array.from(
            { length: count },
            (_, index) => createXmlElement("Uncommitted", [createXmlText(blockId(session, index))]),
          ),
        ),
      );
      let response: Response;
      try {
        response = await client.request({
          method: "PUT",
          key: session.key,
          query: { comp: "blocklist" },
          headers,
          body,
          retry: false,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        throw new AzureCommitError(session.key, cause);
      }
      try {
        await responseText(response, 201, "Put Block List");
        if (!/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(response.headers.get("etag") ?? "")) {
          throw new TypeError("Azure publication receipt lacks an HTTP ETag.");
        }
      } catch (cause) {
        if (cause instanceof AzureError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
          throw cause;
        }
        throw new AzureCommitError(session.key, cause);
      }
      return { offset: session.size, size: session.size, complete: true };
    },
  };
}
