/** Installed provider netlify contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import {
  createNetlifyClient,
  NETLIFY_PROFILE,
  NetlifyClient,
  NetlifyCompletionError,
  NetlifyError,
  NetlifyPublicationError,
} from "@okikio/opfs/netlify";
import { assertBytes } from "../../bytes.mjs";

describe("packed provider netlify", () => {
  it("Netlify authority, conditions and publication outcomes", async () => {
    // This independent injected peer proves installed client behavior, not live Netlify service semantics.
    const netlifyObjects = new Map(), netlifyResponses = [], netlifyRequests = [], netlifyApprovals = [];
    const netlifyMetadata = { label: "café / 雪", source: "packed-peer" };
    const netlifyEncodedMetadata = "b64;" +
      btoa(
        Array.from(new TextEncoder().encode(JSON.stringify(netlifyMetadata)), (value) => String.fromCharCode(value))
          .join(""),
      );
    netlifyObjects.set("seed", { bytes: new Uint8Array([0, 255, 17]), etag: '"seed-1"' });
    let netlifyVersion = 1, netlifyLost = false, netlifyBadCapability = false, netlifyLostAttempts = 0;
    /** Retain each authored response so the case can detect an unreleased reader. */
    const netlifyReply = (response) => {
      netlifyResponses.push(response);
      return response;
    };
    /** Keep API credentials separate from approved data URLs while exercising publication and lost receipts. */
    const netlifyFetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url), headers = request.headers;
      const api = url.origin === "https://netlify-api.example";
      if (!api && url.origin !== "https://netlify-data.example") {
        throw new Error("Packed Netlify dispatched an unapproved authority");
      }
      if (api && headers.get("authorization") !== "Bearer packed-only") {
        throw new Error("Packed Netlify account credential missing");
      }
      if (!api && headers.has("authorization")) throw new Error("Packed Netlify leaked account bearer to capability");
      if (init.redirect !== "error" || init.credentials !== "omit" || !init.signal) {
        throw new Error("Packed Netlify must reject redirects, omit ambient credentials and supply cancellation");
      }
      netlifyRequests.push({ api, method: request.method, path: url.pathname });
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (
        api &&
        (parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "blobs" || parts[3] !== "packed-site" ||
          parts[4] !== "site:fixture")
      ) throw new Error("Packed Netlify API namespace changed");
      const name = api ? parts[5] : parts[1], entry = netlifyObjects.get(name);
      if (api && headers.get("accept") === "application/json;type=signed-url") {
        if (headers.has("if-match") || headers.has("if-none-match") || (await request.arrayBuffer()).byteLength !== 0) {
          throw new Error("Packed Netlify sent final conditions or bytes during negotiation");
        }
        const origin = netlifyBadCapability ? "https://refused.example" : "https://netlify-data.example";
        netlifyBadCapability = false;
        return netlifyReply(Response.json({ url: origin + "/objects/" + name + "?signature=packed" }));
      }
      if (api && request.method === "HEAD") {
        return netlifyReply(
          entry
            ? new Response(null, {
              headers: { "content-length": String(entry.bytes.length), "x-amz-meta-user": netlifyEncodedMetadata },
            })
            : new Response(null, { status: 404 }),
        );
      }
      if (api && request.method === "DELETE") {
        netlifyObjects.delete(name);
        return netlifyReply(new Response(null, { status: 204 }));
      }
      if (api && request.method === "GET" && name === undefined) {
        return netlifyReply(
          Response.json({
            blobs: Array.from(netlifyObjects, ([key, value]) => ({ key, etag: value.etag })),
            directories: [],
          }),
        );
      }
      if (!api && request.method === "GET") {
        return netlifyReply(
          entry
            ? new Response(entry.bytes.slice(), {
              headers: { etag: entry.etag, "x-amz-meta-user": netlifyEncodedMetadata },
            })
            : new Response(null, { status: 404 }),
        );
      }
      if (!api && request.method === "PUT") {
        const payload = new Uint8Array(await request.arrayBuffer());
        if (
          headers.get("if-none-match") === "*" && entry ||
          headers.has("if-match") && headers.get("if-match") !== entry?.etag
        ) return netlifyReply(new Response(null, { status: 412 }));
        const etag = '"packed-' + (++netlifyVersion) + '"';
        netlifyObjects.set(name, { bytes: payload.slice(), etag });
        if (name === "uncertain") {
          netlifyLostAttempts++;
          if (netlifyLost) {
            netlifyLost = false;
            throw new Error("Authored reply lost after publication");
          }
        }
        return netlifyReply(new Response(null, { headers: { etag } }));
      }
      throw new Error("Packed Netlify peer received an unexpected request");
    };
    const netlifyOptions = {
      profile: NETLIFY_PROFILE,
      api: "https://netlify-api.example",
      site: "packed-site",
      store: "fixture",
      token: "packed-only",
      fetch: netlifyFetch,
      authorizeDataURL: (url, request) => {
        netlifyApprovals.push({ method: request.method, key: request.key });
        return new URL(url).origin === "https://netlify-data.example";
      },
    };
    new NetlifyClient(netlifyOptions);
    const netlify = createNetlifyClient(netlifyOptions);
    if (netlifyRequests.length || netlifyApprovals.length) throw new Error("Packed Netlify construction performed I/O");
    const netlifySeed = await netlify.get("seed");
    if (netlifySeed.state !== "present" || netlifySeed.metadata.label !== netlifyMetadata.label) {
      throw new Error("Packed Netlify GET metadata changed");
    }
    assertBytes(netlifySeed.bytes, new Uint8Array([0, 255, 17]));
    const netlifyHead = await netlify.head("seed");
    if (
      netlifyHead.state !== "present" || netlifyHead.etag !== undefined || netlifyHead.size !== 3 ||
      netlifyHead.metadata.source !== "packed-peer"
    ) throw new Error("Packed Netlify HEAD invented an ETag or lost declared metadata");
    const netlifyOriginal = Uint8Array.from({ length: 257 }, (_, index) => (index * 19) & 255);
    const netlifyWritten = await netlify.put("created", netlifyOriginal, { condition: { kind: "new" } });
    if (!netlifyWritten.modified || netlifyWritten.size !== 257 || !netlifyWritten.etag) {
      throw new Error("Packed Netlify PUT acknowledgement changed");
    }
    assertBytes(netlifyObjects.get("created").bytes, netlifyOriginal);
    if ((await netlify.put("created", new Uint8Array([9]), { condition: { kind: "new" } })).modified) {
      throw new Error("Packed Netlify create-only refusal changed");
    }
    if (
      (await netlify.put("created", new Uint8Array([8]), { condition: { kind: "match", etag: '"stale"' } })).modified
    ) throw new Error("Packed Netlify stale-match refusal changed");
    assertBytes(netlifyObjects.get("created").bytes, netlifyOriginal);
    if (
      !(await netlify.put("created", new Uint8Array([1, 2]), {
        condition: { kind: "match", etag: netlifyWritten.etag },
      })).modified
    ) throw new Error("Packed Netlify current match did not publish");
    const netlifyPage = await netlify.list();
    if (
      netlifyPage.state !== "page" || netlifyPage.blobs.map((item) => item.key).sort().join(",") !== "created,seed" ||
      netlifyPage.directories.length
    ) throw new Error("Packed Netlify native page changed");
    netlifyBadCapability = true;
    const netlifyBefore = netlifyRequests.length;
    let netlifyRefused = false;
    try {
      await netlify.get("seed");
    } catch (error) {
      netlifyRefused = error instanceof NetlifyError && error.code === "capability-refused";
    }
    if (!netlifyRefused || netlifyRequests.length !== netlifyBefore + 1) {
      throw new Error("Packed Netlify capability refusal happened after data dispatch");
    }
    netlifyLost = true;
    let netlifyUnknown = false;
    try {
      await netlify.put("uncertain", new Uint8Array([7, 0, 255]));
    } catch (error) {
      netlifyUnknown = error instanceof NetlifyPublicationError && error.outcome === "unknown" &&
        error.key === "uncertain";
    }
    if (!netlifyUnknown || netlifyLostAttempts !== 1) {
      throw new Error("Packed Netlify lost unknown outcome or retried publication");
    }
    assertBytes(netlifyObjects.get("uncertain").bytes, new Uint8Array([7, 0, 255]));
    const netlifyDeleted = await netlify.delete("created");
    if (
      netlifyDeleted.operation !== "delete" || netlifyDeleted.status !== 204 ||
      (await netlify.get("created")).state !== "absent"
    ) throw new Error("Packed Netlify deletion or absence changed");
    if (netlifyResponses.some((response) => response.body?.locked)) {
      throw new Error("Packed Netlify retained an owned response reader");
    }
    const netlifyKnown = new NetlifyCompletionError(netlifyWritten, new Error("Authored later retirement failure"));
    if (netlifyKnown.receipt !== netlifyWritten) throw new Error("Packed Netlify completion error lost its receipt");
  });
});
