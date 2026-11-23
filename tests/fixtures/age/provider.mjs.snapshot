/** Shared test-only Deno cipher transport. It imports no candidate module. */
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { isUint8Array } from "node:util/types";
import { isAbsolute } from "node:path";

// Native slots prevent overridden length/offset properties changing admission.
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const at = Uint8Array.prototype.at;
const buffer = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const offset = Object.getOwnPropertyDescriptor(typed, "byteOffset").get;
const length = Object.getOwnPropertyDescriptor(typed, "byteLength").get;
const encodeBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const decodeBase64 = (text) => new Uint8Array(Buffer.from(text, "base64"));

/**
 * Create an explicit test capability with a denied-permission Deno child.
 * The caller supplies the executable, absolute child path, authentication error
 * constructor and minimal search environment. Importing this module reads no
 * environment and starts no process. The synchronous call is uninterruptible
 * for at most its five-second watchdog; this is not a production provider.
 */
export function createDenoAgeOracle(executable, child, AuthenticationError, environment = {}) {
  if (typeof child !== "string" || !isAbsolute(child) || typeof AuthenticationError !== "function") {
    throw new TypeError("Explicit test child and authentication error constructor required");
  }
  if (typeof executable !== "string" || !executable || executable.length > 8192) {
    throw new TypeError("Explicit Deno test executable required");
  }
  let calls = 0;
  const flags = [
    "run",
    "--no-config",
    "--no-lock",
    "--no-check",
    "--no-code-cache",
    "--cached-only",
    "--no-npm",
    "--no-remote",
    "--no-prompt",
    "--deny-read",
    "--deny-write",
    "--deny-net",
    "--deny-env",
    "--deny-run",
    "--deny-ffi",
    "--deny-sys",
    child,
  ];
  // Environment is transport setup, never permission to read it in the child.
  // Drop credential, preload and Deno flag variables rather than forwarding env.
  const childEnv = {
    PATH: environment.PATH ?? "",
    ...(environment.SystemRoot ? { SystemRoot: environment.SystemRoot } : {}),
    DENO_NO_UPDATE_CHECK: "1",
    DENO_NO_PROMPT: "1",
  };
  function require(value, message) {
    if (!value) throw new Error(message);
  }
  function snapshot(value, min, max) {
    require(isUint8Array(value), "Oracle input requires native bytes");
    at.call(value, Infinity); // Refuse detached or out-of-bounds backing, even for empty input.
    const extent = new Uint8Array(buffer.call(value), offset.call(value), length.call(value));
    require(extent.byteLength >= min && extent.byteLength <= max, "Oracle native input extent");
    return new Uint8Array(extent);
  }
  async function invoke(operation, rawKey, rawNonce, rawInput, options = {}) {
    const key = snapshot(rawKey, 32, 32);
    let nonce, input;
    try {
      nonce = snapshot(rawNonce, 12, 12);
      input = snapshot(rawInput, operation === "decrypt" ? 16 : 0, operation === "decrypt" ? 65552 : 65536);
      const signal = options.signal;
      signal?.throwIfAborted();
      require(++calls <= 512, "Deno test oracle exceeds 512-call module allowance");
      const request = JSON.stringify({
        operation,
        key: encodeBase64(key),
        nonce: encodeBase64(nonce),
        bytes: encodeBase64(input),
      });
      require(new TextEncoder().encode(request).length <= 100 * 1024, "Oracle request ceiling");
      const result = spawnSync(executable, flags, {
        input: request,
        encoding: "utf8",
        env: childEnv,
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1024,
        windowsHide: true,
      });
      signal?.throwIfAborted();
      if (result.error || result.status !== 0 || result.signal !== null) {
        throw new Error("Test-only Deno cipher oracle failed to complete", {
          cause: {
            status: result.status,
            signal: result.signal,
            error: result.error,
            stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 8192) : "",
          },
        });
      }
      require(
        typeof result.stdout === "string" && new TextEncoder().encode(result.stdout).length <= 128 * 1024,
        "Oracle response ceiling",
      );
      const value = JSON.parse(result.stdout);
      require(value !== null && typeof value === "object" && !Array.isArray(value), "Oracle response object");
      const response = value;
      require(JSON.stringify(response) + "\n" === result.stdout, "Oracle exact response EOF/canonical JSON");
      require(
        response.operation === operation && typeof response.deno === "string" &&
          /^2\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(response.deno),
        "Oracle actual Deno runtime/operation",
      );
      require(
        typeof response.v8 === "string" && response.v8.length > 0 && response.v8.length <= 128,
        "Oracle native runtime facts",
      );
      const permissions = response.permissions;
      require(
        permissions !== null && typeof permissions === "object" && !Array.isArray(permissions),
        "Oracle permission receipt",
      );
      const entries = Object.entries(permissions);
      require(
        entries.length === 7 &&
          entries.every(([name, state]) =>
            ["read", "write", "net", "env", "run", "ffi", "sys"].includes(name) && state === "denied"
          ),
        "Oracle restricted runtime admission",
      );
      const fields = Object.keys(response).sort().join(",");
      if (response.authentication === false) {
        require(
          operation === "decrypt" && fields === "authentication,deno,operation,permissions,v8",
          "Oracle failed-finalization response",
        );
        throw new AuthenticationError(
          "authentication",
          "Test payload authentication was not established at native finalization.",
        );
      }
      require(
        response.authentication === true && fields === "authentication,bytes,deno,length,operation,permissions,v8",
        "Oracle successful response fields",
      );
      const expected = input.length + (operation === "encrypt" ? 16 : -16);
      require(
        response.length === expected && typeof response.bytes === "string" && response.bytes.length <= 90000,
        "Oracle returned extent",
      );
      const output = decodeBase64(response.bytes);
      require(output.length === expected && encodeBase64(output) === response.bytes, "Oracle canonical output bytes");
      return new Uint8Array(output);
    } finally {
      key.fill(0);
      nonce?.fill(0);
      input?.fill(0);
    }
  }
  return Object.freeze({
    decrypt: (key, nonce, sealed, options) => invoke("decrypt", key, nonce, sealed, options),
    encrypt: (key, nonce, plain) => invoke("encrypt", key, nonce, plain),
  });
}
