/** Test-only single-unit native cipher oracle. No candidate imports or recipient operations. */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { stdin, stdout } from "node:process";

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
/** Only the runtime facts and denied-permission query used by this child are required. */
interface DenoOracleType {
  readonly version: { readonly deno: string; readonly v8: string };
  readonly permissions: {
    query(descriptor: { readonly name: string }): Promise<{ readonly state: string }>;
  };
}
const deno = (globalThis as typeof globalThis & { readonly Deno?: DenoOracleType }).Deno;
require(deno !== undefined && /^2\./.test(deno.version.deno), "Expected actual Deno 2 runtime");
const denied: Record<string, string> = {};
for (const name of ["read", "write", "net", "env", "run", "ffi", "sys"]) {
  denied[name] = (await deno.permissions.query({ name })).state;
  require(denied[name] === "denied", `Oracle permission not denied: ${name}`);
}
const pieces: Uint8Array[] = [];
let total = 0;
for await (const piece of stdin) {
  require(piece instanceof Uint8Array, "Oracle request requires native bytes");
  total += piece.length;
  require(total <= 100 * 1024, "Oracle request byte ceiling");
  pieces.push(piece);
}
const requestText = Buffer.concat(pieces).toString("utf8");
const parsed: unknown = JSON.parse(requestText);
require(JSON.stringify(parsed) === requestText, "Oracle canonical request and exact EOF");
require(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "Oracle request object");
const request = parsed as Record<string, unknown>;
require(
  JSON.stringify(Object.keys(request).sort()) === JSON.stringify(["bytes", "key", "nonce", "operation"]),
  "Oracle exact request fields",
);
require(request.operation === "encrypt" || request.operation === "decrypt", "Oracle operation");
function decode(value: unknown, min: number, max: number): Buffer<ArrayBuffer> {
  require(
    typeof value === "string" && value.length <= 90000 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    "Oracle Base64 grammar",
  );
  const result = Buffer.from(value, "base64");
  require(
    result.length >= min && result.length <= max && result.toString("base64") === value,
    "Oracle Base64 canonical extent",
  );
  return result;
}
const key = decode(request.key, 32, 32), nonce = decode(request.nonce, 12, 12);
const input = decode(
  request.bytes,
  request.operation === "decrypt" ? 16 : 0,
  request.operation === "decrypt" ? 65552 : 65536,
);
let tentative: Buffer | undefined, tail: Buffer | undefined, output: Buffer | undefined;
let authentication = false;
try {
  if (request.operation === "encrypt") {
    const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    tentative = cipher.update(input);
    tail = cipher.final();
    output = Buffer.concat([tentative, tail, cipher.getAuthTag()]);
    require(output.length === input.length + 16, "Oracle encryption extent");
  } else {
    const cipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    cipher.setAuthTag(input.subarray(-16));
    tentative = cipher.update(input.subarray(0, -16));
    try {
      tail = cipher.final();
    } catch {
      authentication = true;
    }
    if (!authentication) {
      require(tail !== undefined, "Oracle successful finalization omitted its output");
      output = Buffer.concat([tentative, tail]);
      require(output.length === input.length - 16, "Oracle authenticated extent");
    }
  }
  require(authentication === (output === undefined), "Oracle finalization and output disagree");
  const response = {
    operation: request.operation,
    deno: deno.version.deno,
    v8: deno.version.v8,
    permissions: denied,
    ...(output === undefined
      ? { authentication: false }
      : { authentication: true, bytes: output.toString("base64"), length: output.length }),
  };
  const text = JSON.stringify(response) + "\n";
  require(Buffer.byteLength(text) <= 128 * 1024, "Oracle output ceiling");
  await new Promise<void>((resolve, reject) => stdout.write(text, (error) => error ? reject(error) : resolve()));
} finally {
  key.fill(0);
  nonce.fill(0);
  input.fill(0);
  tentative?.fill(0);
  tail?.fill(0);
  output?.fill(0);
}
