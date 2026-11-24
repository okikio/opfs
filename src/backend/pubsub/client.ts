/** Native Google Cloud Pub/Sub unary REST messages and explicit delivery settlement. @module */
import { toInteger } from "../../check.ts";
import { type JsonLimitsType, parseJson } from "../../json.ts";
import { z } from "zod";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isBytes, toView } from "../../bytes.ts";
import { sendRequest } from "../../request.ts";
import type { FetchType } from "../../request.ts";
import { readResponse } from "../../response.ts";
import { openBytes } from "../../stream.ts";
import { close } from "../../close.ts";

/** Local materialization ceiling per message, independent of the service's larger quota. */
export const PUBSUB_MESSAGE_BYTES = 1024 * 1024;
/** The JSON control owner independently bounds all response bodies at 8 MiB. */
export const PUBSUB_BATCH_BYTES = 4 * 1024 * 1024;
/** UTF-8 byte admission checks length before encoding and refuses silent replacement of malformed UTF-16. */
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!empty && value.length === 0) || !value.isWellFormed()) {
    throw new TypeError("Invalid Pub/Sub text.");
  }
  if (new TextEncoder().encode(value).length > maximum) throw new RangeError("Pub/Sub text exceeds its byte policy.");
  return value;
}
/** Semantic schema refinements retain a boolean without foreign string/value details in Zod issues. */
function valid(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}
/** Native IDs remain opaque strings: no binary64 conversion or topic-global delivery-token interpretation. */
function token(value: unknown, maximum: number): string {
  const selected = text(value, maximum);
  if (/[^\u0021-\u007e]/u.test(selected)) throw new TypeError("Unsupported Pub/Sub token profile.");
  return selected;
}
/** Preserve nanoseconds as text; calendar validation does not acquire a clock or round through Date. */
function timestamp(value: unknown): string {
  const selected = text(value, 30);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(selected);
  if (!parts) throw new TypeError("Invalid Pub/Sub UTC timestamp.");
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 || Number(parts[6]) > 59
  ) {
    throw new TypeError("Invalid Pub/Sub UTC timestamp.");
  }
  return selected;
}
/** Object keys are copied from one captured value each; no caller object is retained across credentials/Fetch awaits. */
function attributes(input: unknown): Readonly<Record<string, string>> {
  if (input === undefined) return Object.freeze(Object.create(null) as Record<string, string>);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid Pub/Sub attributes.");
  }
  const keys = Object.keys(input);
  if (keys.length > 100) throw new RangeError("Pub/Sub attribute count exceeds its policy.");
  const result: Record<string, string> = Object.create(null);
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new TypeError("Unsupported Pub/Sub attribute key.");
    }
    const name = text(key, 256), value = (input as Record<string, unknown>)[key];
    result[name] = text(value, 1024, true);
  }
  return Object.freeze(result);
}
/** Input bytes/attributes are data, not server-assigned message IDs or publishing timestamps. */
export const PubsubMessageSchema: z.ZodObject<{
  bytes: z.ZodOptional<z.ZodCustom<Uint8Array>>;
  attributes: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strict> = z.object({
  bytes: z.custom<Uint8Array>((value) => isBytes(value) && value.byteLength <= PUBSUB_MESSAGE_BYTES).optional(),
  attributes: z.record(z.string(), z.string()).refine((value) => {
    try {
      attributes(value);
      return true;
    } catch {
      return false;
    }
  }).optional(),
}).strict().refine((value) => (value.bytes?.byteLength ?? 0) > 0 || Object.keys(value.attributes ?? {}).length > 0);
/** Empty data requires at least one attribute; accepted bytes and attribute strings are copied before dispatch. */
export type PubsubMessageType = Readonly<z.infer<typeof PubsubMessageSchema>>;
/** Normalized delivery evidence. Acknowledgement tokens belong to this subscription delivery, not to an immutable object. */
export const PubsubDeliverySchema: z.ZodObject<{
  ackId: z.ZodString;
  messageId: z.ZodString;
  publishTime: z.ZodString;
  bytes: z.ZodCustom<Uint8Array>;
  attributes: z.ZodRecord<z.ZodString, z.ZodString>;
  orderingKey: z.ZodOptional<z.ZodString>;
  deliveryAttempt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict> = z.object({
  ackId: z.string().refine((value) => valid(() => token(value, 8192))),
  messageId: z.string().refine((value) => valid(() => token(value, 1024))),
  publishTime: z.string().refine((value) => valid(() => timestamp(value))),
  bytes: z.custom<Uint8Array>((value) => isBytes(value) && value.byteLength <= PUBSUB_MESSAGE_BYTES),
  attributes: z.record(z.string(), z.string()).refine((value) => valid(() => attributes(value))),
  orderingKey: z.string().refine((value) => valid(() => text(value, 1024))).optional(),
  deliveryAttempt: z.number().int().nonnegative().max(2147483647).optional(),
}).strict().refine((value) => value.bytes.byteLength > 0 || Object.keys(value.attributes).length > 0);
/** Bytes are private materialized copies; timestamps retain the original UTC fractional precision. */
export type PubsubDeliveryType = Readonly<z.infer<typeof PubsubDeliverySchema>>;
const MessageSchema = z.object({
  data: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  messageId: z.string(),
  publishTime: z.string(),
  orderingKey: z.string().optional(),
});
const PullSchema = z.object({
  receivedMessages: z.array(
    z.object({
      ackId: z.string(),
      message: MessageSchema,
      deliveryAttempt: z.number().int().nonnegative().max(2147483647).optional(),
    }),
  ).max(1000).nullable().optional(),
});
const PublishSchema = z.object({ messageIds: z.array(z.string()).min(1).max(1000) });
const EmptySchema = z.object({}).strict();
/** Sanitized schema failure does not echo OAuth tokens, acknowledgement IDs or message bytes. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid Pub/Sub response grammar.");
  return parsed.data;
}
/** Canonical standard padded base64 is a deliberately finite protobuf-JSON output profile. */
function decode(value: string): Uint8Array<ArrayBuffer> {
  const padding = value.indexOf("=");
  if (
    value.length > 4 * Math.ceil(PUBSUB_MESSAGE_BYTES / 3) || value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(value) ||
    padding !== -1 && (padding < value.length - 2 || padding === value.length - 2 && !value.endsWith("=="))
  ) {
    throw new TypeError("Invalid Pub/Sub message base64.");
  }
  const size = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (size > PUBSUB_MESSAGE_BYTES) throw new RangeError("Pub/Sub message exceeds its policy.");
  const bytes = new Uint8Array(decodeBase64(value));
  if (encodeBase64(bytes) !== value) throw new TypeError("Noncanonical Pub/Sub message base64.");
  return bytes;
}

/** Limits for this service's JSON responses; see `parseJson`. */
const jsonLimits: JsonLimitsType = {
  label: "Pub/Sub",
  maxLength: 8 * 1024 * 1024,
  maxTokens: 100_000,
  maxString: 2_097_152,
  maxScalar: 17,
};

/** One configured project/API origin. Fetch and credential capabilities are borrowed; no socket pool or background task is acquired. */
export interface PubsubClientOptionsType {
  readonly endpoint: string | URL;
  /** Selected project-ID profile: 6–30 lowercase letters/digits/hyphens, beginning with a letter. */
  readonly project: string;
  readonly fetch: FetchType;
  /** Only Authorization may be returned. The detached URL cannot alter the admitted request. Omission permits an explicitly anonymous emulator. */
  readonly credentials?: (url: URL, signal?: AbortSignal) => HeadersInit | undefined | Promise<HeadersInit | undefined>;
  readonly allowHttp?: boolean;
  /** Per-request deadline including credential preparation and owned response reading; default 60 seconds, maximum five minutes. */
  readonly timeoutMs?: number;
  /** Maximum admitted messages per publish/pull/ack batch, default 100 and maximum 1000. */
  readonly maxMessages?: number;
}
/** Per-operation cancellation; no consumer loop or automatic lease renewal is created. */
export interface PubsubOperationType {
  readonly signal?: AbortSignal;
}
/** Explicit positive upper bound; a smaller/empty response does not prove that the backlog is empty. */
export interface PubsubPullType extends PubsubOperationType {
  readonly maxMessages: number;
}
/** Sanitized native HTTP error. Foreign response text is never embedded in library-owned errors. */
export class PubsubError extends Error {
  readonly status: number;
  /**
   * Creates the error.
   * @param status HTTP status the service returned.
   */
  constructor(status: number) {
    super(`Pub/Sub request failed with HTTP ${status}.`);
    this.name = "PubsubError";
    this.status = status;
  }
}
/** Publish, pull, ack and deadline changes all mutate service state. A dispatched request without its complete receipt must not be blindly repeated. */
export class PubsubOutcomeError extends Error {
  readonly outcome = "unknown";
  readonly operation: "publish" | "pull" | "acknowledge" | "modifyAckDeadline";
  readonly resource: string;
  /**
   * Creates the error.
   * @param operation Operation that failed.
   * @param cause Failure that caused this error.
   */
  constructor(operation: PubsubOutcomeError["operation"], resource: string, cause: unknown) {
    super(
      "Pub/Sub operation outcome is unknown; reconcile delivery/application state before deciding whether to repeat.",
      { cause },
    );
    this.name = "PubsubOutcomeError";
    this.operation = operation;
    this.resource = resource;
  }
}
/** Strict resource IDs are literal names, not slashes, project overrides or arbitrary URL segments. */
function resourceId(value: string): string {
  if (
    typeof value !== "string" || value.length < 3 || value.length > 255 ||
    !/^[A-Za-z][A-Za-z0-9\-_.~+%]*$/u.test(value) || value.startsWith("goog")
  ) {
    throw new TypeError("Invalid Pub/Sub topic/subscription ID.");
  }
  return value;
}
/** Fatal UTF-8 plus actual byte/progress budgets before parsing; stream rejection is terminal and is not redundantly cancelled. */
async function control<T>(response: Response, read: (value: string) => T): Promise<T> {
  const body = response.body;
  if (body === null) return read("");
  const reader = openBytes(body);
  let terminal = false, size = 0, empty = 0, result = "";
  let primary: readonly unknown[] = [];
  let admitted: { readonly value: T } | undefined;
  try {
    const encoding = response.headers.get("content-encoding"), rawLength = response.headers.get("content-length");
    if (encoding !== null && encoding !== "identity") {
      throw new TypeError("Encoded Pub/Sub control response is unsupported.");
    }
    if (rawLength !== null && (!/^(0|[1-9][0-9]{0,7})$/u.test(rawLength) || Number(rawLength) > 8 * 1024 * 1024)) {
      throw new RangeError("Pub/Sub control body exceeds policy.");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (reason) {
        terminal = true;
        throw reason;
      }
      if (next.done) {
        terminal = true;
        break;
      }
      if (!isBytes(next.value)) throw new TypeError("Pub/Sub control body requires bytes.");
      const bytes = toView(next.value);
      size += bytes.length;
      if (size > 8 * 1024 * 1024) throw new RangeError("Pub/Sub control body exceeds policy.");
      if (!bytes.length) { if (++empty > 16) throw new TypeError("Pub/Sub control body makes no progress."); }
      else empty = 0;
      result += decoder.decode(bytes, { stream: true });
    }
    result += decoder.decode();
    if (rawLength !== null && size !== Number(rawLength)) throw new TypeError("Pub/Sub control body length differs.");
    // A complete native receipt remains acknowledged even if later lock release fails.
    admitted = { value: read(result) };
  } catch (reason) {
    primary = [reason];
  }
  await close([...(terminal ? [] : [() => reader.cancel(primary[0])]), () => reader.releaseLock()], primary);
  return admitted!.value;
}
/** Unary native operations. The caller owns topics, subscriptions, application processing, acknowledgement decisions and exclusive recovery. */
export class PubsubClient {
  readonly #endpoint: URL;
  readonly #project: string;
  readonly #fetch: FetchType;
  readonly #credentials: PubsubClientOptionsType["credentials"];
  readonly #timeout: number;
  readonly #maximum: number;
  /**
   * Creates the client from `options`.
   * @param options Options that configure the client.
   */
  constructor(options: PubsubClientOptionsType) {
    const raw = String(options.endpoint),
      project = options.project,
      suppliedFetch = options.fetch,
      credentials = options.credentials;
    if (
      raw.length > 8192 || /[^\u0021-\u007e]/u.test(raw) || raw.includes("\\") || /%(?:2e|2f|5c)/iu.test(raw) ||
      raw.split("/").some((part) => part === "." || part === "..")
    ) throw new TypeError("Invalid Pub/Sub endpoint.");
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new TypeError("Invalid Pub/Sub endpoint.");
    }
    if (
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && options.allowHttp === true)
    ) throw new TypeError("Pub/Sub requires an explicit API origin without credentials, query or path.");
    if (typeof project !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) {
      throw new TypeError("Unsupported Pub/Sub project-ID profile.");
    }
    if (typeof suppliedFetch !== "function" || credentials !== undefined && typeof credentials !== "function") {
      throw new TypeError("Invalid Pub/Sub request capability.");
    }
    this.#endpoint = endpoint;
    this.#project = project;
    this.#fetch = suppliedFetch.bind(options);
    this.#credentials = credentials?.bind(options);
    this.#timeout = toInteger(options.timeoutMs ?? 60000, "Pub/Sub integer", 300000, 1);
    this.#maximum = toInteger(options.maxMessages ?? 100, "Pub/Sub integer", 1000, 1);
  }
  /** Every exposed operation is nonreplayable. Classify a known refusal before unused-body cleanup so its independent failure cannot invent uncertainty. */
  async #request<T>(
    kind: "topics" | "subscriptions",
    id: string,
    operation: PubsubOutcomeError["operation"],
    data: unknown,
    admit: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const resource = `projects/${this.#project}/${kind}/${id}`;
    const url = new URL(`v1/projects/${this.#project}/${kind}/${encodeURIComponent(id)}:${operation}`, this.#endpoint);
    const body = JSON.stringify(data);
    if (body.length > 8 * 1024 * 1024 || new TextEncoder().encode(body).length > 8 * 1024 * 1024) {
      throw new RangeError("Pub/Sub request exceeds its JSON policy.");
    }
    let dispatched = false, acknowledged = false, refused = false;
    try {
      const response = await sendRequest(async (attemptSignal) => {
        attemptSignal?.throwIfAborted();
        const headers = new Headers(await this.#credentials?.(new URL(url), attemptSignal));
        attemptSignal?.throwIfAborted();
        for (const name of headers.keys()) {
          if (name !== "authorization") throw new TypeError("Pub/Sub credentials may supply only Authorization.");
        }
        headers.set("content-type", "application/json");
        headers.set("accept", "application/json");
        headers.set("accept-encoding", "identity");
        return {
          input: url,
          init: {
            method: "POST",
            body,
            headers,
            redirect: "manual",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          },
        };
      }, {
        fetch: async (input, init) => {
          dispatched = true;
          return await this.#fetch(input, init);
        },
        replayable: false,
        policy: { retries: 0, timeoutMs: this.#timeout },
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200) {
        return await readResponse(response, () => {
          refused = response.status >= 400 && response.status < 500 && response.status !== 408 &&
            response.status !== 429;
          throw new PubsubError(response.status);
        });
      }
      const result = await control(response, (raw) => {
        const admitted = admit(operation === "pull" && raw.trim() === "" ? {} : parseJson(raw, jsonLimits));
        acknowledged = true;
        return admitted;
      });
      signal?.throwIfAborted();
      return result;
    } catch (reason) {
      if (dispatched && !acknowledged && !refused) throw new PubsubOutcomeError(operation, resource, reason);
      throw reason;
    }
  }
  /** Publish a finite explicit batch. Returned IDs are in request order and topic-scoped; they do not identify a durable file or subscriber completion. */
  async publish(
    topic: string,
    messages: readonly PubsubMessageType[],
    options: PubsubOperationType = {},
  ): Promise<readonly string[]> {
    const signal = options.signal;
    signal?.throwIfAborted();
    topic = resourceId(topic);
    if (!Array.isArray(messages)) throw new TypeError("Pub/Sub publish requires a finite message array.");
    const count = toInteger(messages.length, "Pub/Sub integer", this.#maximum, 1),
      wire: { data?: string; attributes?: Readonly<Record<string, string>> }[] = [];
    let total = 0, wireBytes = 15;
    for (let index = 0; index < count; index++) {
      const message = messages[index];
      if (message === null || typeof message !== "object") throw new TypeError("Invalid Pub/Sub message.");
      if (Object.keys(message).some((name) => name !== "bytes" && name !== "attributes")) {
        throw new TypeError("Unsupported Pub/Sub publisher field.");
      }
      const suppliedBytes = message.bytes;
      if (suppliedBytes !== undefined && !isBytes(suppliedBytes)) {
        throw new TypeError("Pub/Sub message data requires bytes.");
      }
      const view = suppliedBytes === undefined ? new Uint8Array(0) : toView(suppliedBytes);
      toInteger(view.length, "Pub/Sub integer", PUBSUB_MESSAGE_BYTES);
      // Take byte ownership before another caller getter can mutate the borrowed view.
      const bytes = new Uint8Array(view), attrs = attributes(message.attributes);
      if (!bytes.length && !Object.keys(attrs).length) {
        throw new TypeError("Pub/Sub message requires nonempty data or attributes.");
      }
      total += bytes.length;
      if (total > PUBSUB_BATCH_BYTES) throw new RangeError("Pub/Sub publish bytes exceed the batch policy.");
      const captured = {
        ...(bytes.length ? { data: encodeBase64(bytes) } : {}),
        ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
      };
      wireBytes += new TextEncoder().encode(JSON.stringify(captured)).length + 1;
      if (wireBytes > 8 * 1024 * 1024) throw new RangeError("Pub/Sub encoded publish batch exceeds policy.");
      wire.push(captured);
    }
    return await this.#request("topics", topic, "publish", { messages: wire }, (value) => {
      const result = parse(PublishSchema, value);
      if (result.messageIds.length !== count || new Set(result.messageIds).size !== count) {
        throw new TypeError("Pub/Sub publish receipt count/identity differs.");
      }
      return Object.freeze(result.messageIds.map((id) => token(id, 1024)));
    }, signal);
  }
  /** Pull acquires delivery state. An empty batch can mean no immediately returned messages; it is not proof of an empty backlog. */
  async pull(subscription: string, options: PubsubPullType): Promise<readonly PubsubDeliveryType[]> {
    const signal = options.signal, count = options.maxMessages;
    signal?.throwIfAborted();
    subscription = resourceId(subscription);
    toInteger(count, "Pub/Sub integer", this.#maximum, 1);
    return await this.#request("subscriptions", subscription, "pull", { maxMessages: count }, (value) => {
      const deliveries = parse(PullSchema, value).receivedMessages ?? [];
      if (deliveries.length > count) throw new RangeError("Pub/Sub returned more messages than requested.");
      let total = 0;
      const seen = new Set<string>();
      return Object.freeze(deliveries.map((delivery) => {
        const ackId = token(delivery.ackId, 8192), messageId = token(delivery.message.messageId, 1024);
        if (seen.has(ackId)) throw new TypeError("Pub/Sub returned duplicate delivery tokens.");
        seen.add(ackId);
        const bytes = decode(delivery.message.data ?? ""), attrs = attributes(delivery.message.attributes);
        if (!bytes.length && !Object.keys(attrs).length) {
          throw new TypeError("Pub/Sub delivery requires data or attributes.");
        }
        total += bytes.length;
        if (total > PUBSUB_BATCH_BYTES) throw new RangeError("Pub/Sub pull bytes exceed the batch policy.");
        const orderingKey = delivery.message.orderingKey;
        return Object.freeze({
          ackId,
          messageId,
          bytes,
          attributes: attrs,
          publishTime: timestamp(delivery.message.publishTime),
          ...(orderingKey === undefined || orderingKey === "" ? {} : { orderingKey: text(orderingKey, 1024) }),
          ...(delivery.deliveryAttempt === undefined ? {} : { deliveryAttempt: delivery.deliveryAttempt }),
        });
      }));
    }, signal);
  }
  /** Acknowledge explicit delivery tokens. A successful REST response is not proof of exactly-once application processing or permanent non-redelivery. */
  async acknowledge(subscription: string, ackIds: readonly string[], options: PubsubOperationType = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    subscription = resourceId(subscription);
    const ids = this.#ackIds(ackIds);
    await this.#request("subscriptions", subscription, "acknowledge", { ackIds: ids }, (value) => {
      parse(EmptySchema, value);
    }, signal);
  }
  /** Explicit native lease change, 0–600 seconds from server receipt. Zero requests immediate redelivery; no background renewal is created. */
  async modifyAckDeadline(
    subscription: string,
    ackIds: readonly string[],
    seconds: number,
    options: PubsubOperationType = {},
  ): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    subscription = resourceId(subscription);
    const ids = this.#ackIds(ackIds), deadline = toInteger(seconds, "Pub/Sub integer", 600);
    await this.#request("subscriptions", subscription, "modifyAckDeadline", {
      ackIds: ids,
      ackDeadlineSeconds: deadline,
    }, (value) => {
      parse(EmptySchema, value);
    }, signal);
  }
  #ackIds(input: readonly string[]): readonly string[] {
    if (!Array.isArray(input)) throw new TypeError("Pub/Sub acknowledgement requires a finite token array.");
    const count = toInteger(input.length, "Pub/Sub integer", this.#maximum, 1), ids: string[] = [];
    for (let index = 0; index < count; index++) ids.push(token(input[index], 8192));
    if (new Set(ids).size !== count) throw new TypeError("Duplicate Pub/Sub acknowledgement tokens.");
    return ids;
  }
}
/** Pure local configuration. No service discovery, credential acquisition or connection occurs until an explicit operation. */
export function createPubsubClient(options: PubsubClientOptionsType): PubsubClient {
  return new PubsubClient(options);
}
