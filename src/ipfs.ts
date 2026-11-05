/** Read-only IPFS gateway access with explicit representation and block trust. @module */
import { HttpError, openHttpSource } from "./http.ts";
import type { HttpSourceOptionsType } from "./http.ts";
import { sendRequest } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes } from "./stream.ts";
import { createByteSource } from "./source.ts";
import type { ByteSourceType } from "./source.ts";
import { parseCid, verifyBlock } from "./content/cid.ts";
import { openCar } from "./content/car.ts";

/** Trust is part of the result, so HTTP stability cannot be mistaken for content verification. */
export interface IpfsSourceType extends ByteSourceType {
  readonly cid: string;
  readonly verification: "gateway" | "sha2-256";
  readonly representation: "file" | "raw-block";
}

/** Explicit gateway ownership. No credentials, gateway discovery or IPNS resolution are implicit. */
export interface IpfsOptionsType extends HttpSourceOptionsType {
  /** HTTP(S) path prefix, e.g. https://gateway.example/; /ipfs/{cid} is appended. */
  readonly gateway: string | URL;
  /** Required. Verified modes expose a raw root block only, not a decoded UnixFS file. */
  readonly mode: "trusted" | "verified-raw" | "verified-car";
  /** Separate literal segments, supported only for trusted gateway file representations. */
  readonly path?: readonly string[];
  /** Whole response allocation policy: default 8 MiB raw, 32 MiB CAR; implementation ceiling 256 MiB. */
  readonly maxResponseBytes?: number;
  /** Verified block allocation policy; defaults to 8 MiB. */
  readonly maxBlockBytes?: number;
}

/** Builds a path gateway URL without allowing caller text to become a query or traversal. */
function location(gateway: string | URL, cid: string, segments: readonly string[]): URL {
  const url = new URL(gateway);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("An IPFS gateway requires HTTP(S), without embedded credentials, query or fragment.");
  }
  for (const part of segments) {
    if (!part || part === "." || part === ".." || /[/\\\0]/.test(part)) {
      throw new TypeError("Invalid IPFS path segment.");
    }
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ipfs/${cid}${
    segments.map((part) => `/${encodeURIComponent(part)}`).join("")
  }`;
  return url;
}

/** Opens one root or gateway file, with no upload/pinning/filesystem claims.
 * Trusted mode delegates HEAD/conditional exact ranges to the HTTP source and
 * retains its provider/caller stability. Its CID URL does not authenticate file
 * bytes. Verified modes collect a bounded raw/CAR response, verify the entire
 * requested SHA2-256 raw block, then expose an owned immutable snapshot whose
 * later ranges are slices of the verified bytes. No full-response retry occurs
 * after body acquisition. The caller owns Fetch/authentication resources.
 */
export async function openIpfsSource(cid: string | Uint8Array, options: IpfsOptionsType): Promise<IpfsSourceType> {
  const {
    signal,
    mode,
    gateway,
    path = [],
    maxResponseBytes = mode === "verified-car" ? 32 * 1024 * 1024 : 8 * 1024 * 1024,
    maxBlockBytes = 8 * 1024 * 1024,
    fetch: fetcher = globalThis.fetch,
    headers,
    credentials = "omit",
    policy,
    identity,
    assumeStable,
    maxReadBytes,
  } = options;
  signal?.throwIfAborted();
  if (mode !== "trusted" && mode !== "verified-raw" && mode !== "verified-car") {
    throw new TypeError("An explicit IPFS trust mode is required.");
  }
  const parsed = parseCid(cid);
  const url = location(gateway, parsed.id, [...path]);
  const httpOptions: HttpSourceOptionsType = {
    fetch: fetcher,
    credentials,
    ...(headers === undefined ? {} : { headers }),
    ...(policy === undefined ? {} : { policy: { ...policy } }),
    ...(identity === undefined ? {} : { identity }),
    ...(assumeStable === undefined ? {} : { assumeStable }),
    ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
    ...(signal === undefined ? {} : { signal }),
  };
  if (mode === "trusted") {
    const source = await openHttpSource(url, httpOptions);
    return Object.freeze({ ...source, cid: parsed.id, verification: "gateway", representation: "file" });
  }
  if (path.length !== 0 || parsed.codec !== 0x55) {
    throw new TypeError("Verified byte sources currently require a raw root CID without a path.");
  }
  if (parsed.hashCode !== 0x12 || parsed.digest.length !== 32) throw new TypeError("Unsupported IPFS block multihash.");
  for (const value of [maxResponseBytes, maxBlockBytes]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 256 * 1024 * 1024) {
      throw new RangeError("Invalid IPFS response/block limit (ceiling 256 MiB).");
    }
  }
  const format = mode === "verified-car" ? "car" : "raw";
  const media = `application/vnd.ipld.${format}`;
  url.searchParams.set("format", format);
  if (format === "car") {
    url.searchParams.set("dag-scope", "block");
    url.searchParams.set("car-version", "1");
  }
  const auth = typeof headers === "function" ? headers : new Headers(headers);
  const response = await sendRequest(async (attemptSignal) => {
    const admitted = new Headers(typeof auth === "function" ? await auth(new URL(url)) : auth);
    for (
      const name of [
        "host",
        "range",
        "if-range",
        "if-match",
        "if-none-match",
        "if-modified-since",
        "if-unmodified-since",
        "content-length",
        "transfer-encoding",
      ]
    ) admitted.delete(name);
    admitted.set("accept", format === "car" ? `${media}; version=1` : media);
    admitted.set("accept-encoding", "identity");
    return {
      input: new URL(url),
      init: {
        method: "GET",
        headers: admitted,
        redirect: "manual",
        credentials,
        ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
      },
    };
  }, {
    fetch: fetcher,
    replayable: true,
    ...(policy === undefined ? {} : { policy: { ...policy } }),
    ...(signal === undefined ? {} : { signal }),
  });
  // Until body transfer succeeds, this operation owns retirement on every header failure.
  let declared: number | undefined;
  try {
    signal?.throwIfAborted();
    if (response.status !== 200) throw new HttpError(response.status, "IPFS GET");
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== media) {
      throw new TypeError("IPFS gateway returned a different representation type.");
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      throw new TypeError("Encoded IPFS block responses are unsupported.");
    }
    const length = response.headers.get("content-length");
    if (length !== null) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
        throw new TypeError("Invalid IPFS Content-Length.");
      }
      declared = Number(length);
      if (declared > maxResponseBytes || (format === "raw" && declared > maxBlockBytes)) {
        throw new RangeError("IPFS response exceeds its byte limit.");
      }
    }
    if (response.body === null) throw new TypeError("IPFS block response requires a body.");
  } catch (reason) {
    return await readResponse(response, () => {
      throw reason;
    });
  }
  const bytes = await collectBytes(
    response.body!,
    Math.min(maxResponseBytes, format === "raw" ? maxBlockBytes : maxResponseBytes),
    signal,
    "read",
    "IPFS block",
  );
  signal?.throwIfAborted();
  if (declared !== undefined && bytes.byteLength !== declared) {
    throw new TypeError("IPFS response length differs from Content-Length.");
  }
  let block = bytes;
  if (format === "car") {
    const car = await openCar(createByteSource(bytes), {
      maxArchiveBytes: maxResponseBytes,
      maxBlockBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    block = (await car.read(parsed.bytes, signal === undefined ? {} : { signal })).bytes;
  } else {await verifyBlock(parsed.bytes, bytes, {
      maxBytes: maxBlockBytes,
      ...(signal === undefined ? {} : { signal }),
    });}
  const source = createByteSource(block, { identity: `ipfs:${parsed.id}` });
  return Object.freeze({ ...source, cid: parsed.id, verification: "sha2-256", representation: "raw-block" });
}
