/**
 * Reads S3 responses: object metadata, commit receipts, error bodies, success XML
 * and list entries.
 *
 * @module
 */
import { S3Error } from "./error.ts";
import type { S3ListEncodingType } from "./types.ts";
import type { ResponseTextType } from "../../response.ts";
import { readResponse } from "../../response.ts";
import { getXmlElements, getXmlText, getXmlValue, parseXmlRoot } from "../../xml.ts";
import type { ObjectEntryType, ObjectReceiptType, ObjectStatType } from "../../driver/object.ts";

/** Converts S3 response headers into provider-neutral object metadata. */
export function getStat(headers: Headers): ObjectStatType {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.toLowerCase().startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
  }
  const size = Number.parseInt(headers.get("content-length") ?? "0", 10);
  const modified = headers.get("last-modified");
  return {
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    ...(modified === null ? {} : { lastModified: new Date(modified).getTime() }),
    ...(headers.get("content-type") === null ? {} : { mediaType: headers.get("content-type")! }),
    ...(headers.get("etag") === null ? {} : { etag: headers.get("etag")! }),
    ...(headers.get("x-amz-version-id") === null ? {} : { version: headers.get("x-amz-version-id")! }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

/** Returns properties of this operation; response-body length is not object length. */
export function getReceipt(
  response: Response,
  size: number,
  properties: Pick<ObjectStatType, "mediaType" | "metadata">,
  etag?: string,
): ObjectReceiptType {
  return {
    size,
    ...(properties.mediaType === undefined ? {} : { mediaType: properties.mediaType }),
    ...(properties.metadata === undefined ? {} : { metadata: { ...properties.metadata } }),
    ...((etag ?? response.headers.get("etag")) == null ? {} : { etag: etag ?? response.headers.get("etag")! }),
    ...(response.headers.get("x-amz-version-id") === null
      ? {}
      : { version: response.headers.get("x-amz-version-id")! }),
    ...(response.headers.get("x-amz-request-id") === null
      ? {}
      : { requestId: response.headers.get("x-amz-request-id")! }),
  };
}

/** Reads and throws a structured S3 error without losing provider request IDs. */
export async function assertResponse(
  response: Response,
  operation: string,
  text?: ResponseTextType,
): Promise<Response> {
  if (response.ok) return response;
  if (text === undefined) return await readResponse(response, (owned) => assertResponse(response, operation, owned));

  let code: string | undefined;
  let requestId = response.headers.get("x-amz-request-id") ?? undefined;
  let hostId = response.headers.get("x-amz-id-2") ?? undefined;
  let message = `${operation} failed with HTTP ${response.status}.`;
  let body = "";
  let secondary: { readonly reason: unknown } | undefined;
  try {
    body = await text();
  } catch (reason) {
    secondary = { reason };
  }

  if (body.trim().startsWith("<")) {
    try {
      const root = parseXmlRoot(body);
      code = getXmlValue(root, "Code");
      requestId ??= getXmlValue(root, "RequestId");
      hostId ??= getXmlValue(root, "HostId");
      message = getXmlValue(root, "Message") ?? message;
    } catch (reason) {
      // A gateway can return HTML or malformed XML. The HTTP status and provider
      // request headers still preserve the most useful failure evidence.
      secondary = { reason };
    }
  }

  throw new S3Error(message, response, {
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(hostId === undefined ? {} : { hostId }),
    ...(secondary === undefined ? {} : { cause: secondary.reason }),
  });
}

/** Parses an HTTP-success S3 XML response and detects the protocol's embedded `<Error>` form. */
export async function getSuccessXml(
  response: Response,
  operation: string,
  text: ResponseTextType,
  rejected?: () => void,
) {
  await assertResponse(response, operation, text);
  const body = await text();
  if (!body.trim().startsWith("<")) throw new SyntaxError("S3 success acknowledgement requires XML.");
  const root = parseXmlRoot(body);
  const errors = getXmlElements(root, "Error");
  if (errors.length === 0) return root;
  if (root.name.local !== "Error" || errors.length !== 1) {
    throw new SyntaxError("S3 acknowledgement mixes success and error authority.");
  }
  const error = root;
  rejected?.();

  throw new S3Error(getXmlValue(error, "Message") ?? `${operation} failed after HTTP 200.`, response, {
    ...(getXmlValue(error, "Code") === undefined ? {} : { code: getXmlValue(error, "Code")! }),
    ...(getXmlValue(error, "RequestId") === undefined ? {} : { requestId: getXmlValue(error, "RequestId")! }),
    ...(getXmlValue(error, "HostId") === undefined ? {} : { hostId: getXmlValue(error, "HostId")! }),
  });
}

/** Converts one `ListObjectsV2` `<Contents>` element into portable metadata. */
export function getListObject(
  content: Parameters<typeof getXmlValue>[0],
  encoded: boolean,
  policy: S3ListEncodingType,
): ObjectEntryType {
  const text = getXmlText(content, "Key") ?? "";
  const key = encoded ? decodeListIdentity(text, policy) : text;
  const size = Number.parseInt(getXmlValue(content, "Size") ?? "0", 10);
  const modified = getXmlValue(content, "LastModified");
  const etag = getXmlValue(content, "ETag");
  return {
    key,
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    ...(modified === undefined ? {} : { lastModified: new Date(modified).getTime() }),
    ...(etag === undefined ? {} : { etag }),
  };
}

/** Only the configured wire dialect can give + space semantics; guessing would alias real keys. */
export function decodeListIdentity(text: string, policy: S3ListEncodingType): string {
  return decodeURIComponent(policy === "form" ? text.replace(/\+/g, "%20") : text);
}
