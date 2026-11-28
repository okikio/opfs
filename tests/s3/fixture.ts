/** S3: Deterministic provider fixtures retain independent wire oracles and exact failures. */
import { parse } from "@std/xml/parse";

/** Reads transmitted multipart scalar fields independently of the request builder. */
export function completedParts(value: string): Record<string, string>[] {
  const root = parse(value).root;
  if (root.name.local !== "CompleteMultipartUpload") throw new SyntaxError("Expected multipart completion XML.");
  return root.children.filter((node) => node.type === "element").map((part) => {
    if (part.name.local !== "Part") throw new SyntaxError("Expected direct Part entries.");
    const fields = part.children.filter((node) => node.type === "element");
    if (
      fields.length !== 2 || fields.filter((field) => field.name.local === "PartNumber").length !== 1 ||
      fields.filter((field) => field.name.local === "ETag").length !== 1
    ) {
      throw new SyntaxError("Expected one part number and ETag.");
    }
    return Object.fromEntries(fields.map((field) => {
      if (field.children.some((node) => node.type === "element")) throw new SyntaxError("Expected scalar part fields.");
      return [
        field.name.local,
        field.children.filter((node) => node.type === "text" || node.type === "cdata")
          .map((node) => node.text).join(""),
      ];
    }));
  });
}

/** AWS documentation credentials used only for deterministic Signature Version 4 tests. */
export const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

/** Captures thrown undefined independently from successful resolution. */
export async function rejectedResponse(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected response retirement to reject.");
}

/** Creates one S3-style XML response without coupling tests to an HTTP server. */
export function xml(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "application/xml", ...(init.headers ?? {}) },
    ...init,
  });
}

/** Refreshable credential source used to prove per-request SigV4 resolution. */
export class S3CredentialSource {
  /** Number of times the client requested fresh credentials. */
  calls = 0;

  /** Returns valid temporary credentials with a request-specific session token. */
  get(): typeof credentials & { sessionToken: string } {
    this.calls += 1;
    return { ...credentials, sessionToken: `session-${this.calls}` };
  }
}
