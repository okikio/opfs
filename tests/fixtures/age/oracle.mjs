/** Test-only single-unit native cipher oracle. No candidate imports or recipient operations. */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { stdin, stdout } from "node:process";

function require(condition, message) {
  if (!condition) throw new Error(message);
}
const deno = globalThis.Deno;
require(deno !== undefined && /^2\./.test(deno.version.deno), "Expected actual Deno 2 runtime");
const denied = {};
for (const name of ["read", "write", "net", "env", "run", "ffi", "sys"]) {
  denied[name] = (await deno.permissions.query({ name })).state;
  require(denied[name] === "denied", `Oracle permission not denied: ${name}`);
}
const pieces = [];
let total = 0;
for await (const piece of stdin) {
  total += piece.length;
  require(total <= 100 * 1024, "Oracle request byte ceiling");
  pieces.push(piece);
}
const requestText = Buffer.concat(pieces).toString("utf8");
const request = JSON.parse(requestText);
require(JSON.stringify(request) === requestText, "Oracle canonical request and exact EOF");
require(request !== null && typeof request === "object" && !Array.isArray(request), "Oracle request object");
require(
  JSON.stringify(Object.keys(request).sort()) === JSON.stringify(["bytes", "key", "nonce", "operation"]),
  "Oracle exact request fields",
);
require(request.operation === "encrypt" || request.operation === "decrypt", "Oracle operation");
function decode(value, min, max) {
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
let tentative, tail, output;
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
      output = Buffer.concat([tentative, tail]);
      require(output.length === input.length - 16, "Oracle authenticated extent");
    }
  }
  const response = {
    operation: request.operation,
    deno: deno.version.deno,
    v8: deno.version.v8,
    permissions: denied,
    ...(authentication
      ? { authentication: false }
      : { authentication: true, bytes: output.toString("base64"), length: output.length }),
  };
  const text = JSON.stringify(response) + "\n";
  require(Buffer.byteLength(text) <= 128 * 1024, "Oracle output ceiling");
  await new Promise((resolve, reject) => stdout.write(text, (error) => error ? reject(error) : resolve()));
} finally {
  key.fill(0);
  nonce.fill(0);
  input.fill(0);
  tentative?.fill(0);
  tail?.fill(0);
  output?.fill(0);
}
