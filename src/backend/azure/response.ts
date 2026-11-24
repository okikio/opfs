/**
 * Reads Azure Blob responses: object metadata, commit receipts and error bodies.
 *
 * @module
 */
import { AzureError } from "./error.ts";
import type { ObjectReceiptType, ObjectStatType } from "../../driver/object.ts";
import type { ResponseTextType } from "../../response.ts";
import { readResponse } from "../../response.ts";
import { getXmlElements, getXmlText, getXmlValue, parseXmlRoot } from "../../xml.ts";

/** Converts Azure response headers to provider-neutral object metadata. */
export function getStat(headers: Headers): ObjectStatType {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.toLowerCase().startsWith("x-ms-meta-")) metadata[name.slice("x-ms-meta-".length)] = value;
  }
  const size = Number.parseInt(headers.get("content-length") ?? "0", 10);
  const modified = headers.get("last-modified");
  return {
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    ...(modified === null ? {} : { lastModified: new Date(modified).getTime() }),
    ...(headers.get("content-type") === null ? {} : { mediaType: headers.get("content-type")! }),
    ...(headers.get("etag") === null ? {} : { etag: headers.get("etag")! }),
    ...(headers.get("x-ms-version-id") === null ? {} : { version: headers.get("x-ms-version-id")! }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

/** Parses Azure XML failures while preserving HTTP-only failures from proxies. */
export async function assertResponse(
  response: Response,
  operation: string,
  text?: ResponseTextType,
): Promise<Response> {
  if (response.ok) return response;
  if (text === undefined) return await readResponse(response, (owned) => assertResponse(response, operation, owned));
  let body = "";
  let secondary: { readonly reason: unknown } | undefined;
  try {
    body = await text();
  } catch (reason) {
    secondary = { reason };
  }
  let code = response.headers.get("x-ms-error-code") ?? undefined;
  let message = `${operation} failed with HTTP ${response.status}.`;
  if (body.trim().startsWith("<")) {
    try {
      const root = parseXmlRoot(body);
      code ??= getXmlValue(root, "Code");
      message = getXmlValue(root, "Message") ?? message;
    } catch (reason) {
      // A proxy can return HTML or malformed XML. Preserve the HTTP failure.
      secondary = { reason };
    }
  }
  throw new AzureError(message, response, {
    ...(code === undefined ? {} : { code }),
    ...(response.headers.get("x-ms-request-id") === null
      ? {}
      : { requestId: response.headers.get("x-ms-request-id")! }),
    ...(secondary === undefined ? {} : { cause: secondary.reason }),
  });
}

/** Azure marks percent-encoded names explicitly; opaque markers are never decoded. */
export function getName(node: Parameters<typeof getXmlText>[0]): string | undefined {
  const element = getXmlElements(node, "Name")[0];
  if (element === undefined) return undefined;
  const text = getXmlText(element, "Name")!;
  return element.attributes.Encoded === "true" ? decodeURIComponent(text) : text;
}

/** Returns this publication's acknowledgement, never a later writer's properties. */
export function getReceipt(
  response: Response,
  size: number,
  properties: Pick<ObjectStatType, "mediaType" | "metadata">,
): ObjectReceiptType {
  const stat = getStat(response.headers);
  return {
    size,
    ...(properties.mediaType === undefined ? {} : { mediaType: properties.mediaType }),
    ...(properties.metadata === undefined ? {} : { metadata: { ...properties.metadata } }),
    ...(stat.etag === undefined ? {} : { etag: stat.etag }),
    ...(stat.version === undefined ? {} : { version: stat.version }),
    ...(stat.lastModified === undefined ? {} : { lastModified: stat.lastModified }),
    ...(response.headers.get("x-ms-request-id") === null
      ? {}
      : { requestId: response.headers.get("x-ms-request-id")! }),
  };
}
