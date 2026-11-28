/** Azure: Deterministic provider fixtures retain independent wire oracles and exact failures. */
import { parse } from "@std/xml/parse";

/**
 * Reads the ordered Latest-only block list emitted by this client independently.
 *
 * Microsoft's Put Block List grammar defines direct block entries in source
 * order. XML owns formatting, character references and CDATA, so fixture storage
 * must use decoded scalar IDs instead of a serializer-specific tag expression.
 * This reader does not claim acceptance of arbitrary Azure request namespaces or
 * other block-selection kinds that this client does not emit.
 * https://learn.microsoft.com/rest/api/storageservices/put-block-list#request-body
 */
export function latestBlocks(value: string): string[] {
  const root = parse(value).root;
  if (root.name.raw !== "BlockList") throw new SyntaxError("Expected a BlockList request.");
  return root.children.filter((node) => node.type === "element").map((block) => {
    if (block.name.raw !== "Latest" || block.children.some((node) => node.type === "element")) {
      throw new SyntaxError("Expected direct scalar Latest block IDs.");
    }
    const id = block.children.filter((node) => node.type === "text" || node.type === "cdata")
      .map((node) => node.text).join("");
    if (id.length === 0) throw new SyntaxError("Expected a nonempty block ID.");
    return id;
  });
}

/** Captures an actual rejection independently from successful undefined resolution. */
export async function rejectedResponse(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected response retirement to reject.");
}

/** Creates one Azure-style XML response without coupling tests to an HTTP server. */
export function xml(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "application/xml", ...(init.headers ?? {}) },
    ...init,
  });
}
