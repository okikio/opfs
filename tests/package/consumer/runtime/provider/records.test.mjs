/** Installed provider records contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createCmisClient } from "@okikio/opfs/cmis";
import { createCouchdbClient } from "@okikio/opfs/couchdb";
import { createEtcdClient } from "@okikio/opfs/etcd";
import { assertBytes } from "../../bytes.mjs";
import cmisInput from "../../data/provider/cmis.json" with { type: "json" };
import couchdbInput from "../../data/provider/couchdb.json" with { type: "json" };
import etcdInput from "../../data/provider/etcd.json" with { type: "json" };

describe("packed provider records", () => {
  it("CMIS native identities and content", async () => {
    const cmisFixture = cmisInput;
    const cmisOriginal = Uint8Array.from(atob(cmisFixture.content), (byte) => byte.charCodeAt(0));
    const cmis = createCmisClient({
      repository: cmisFixture.repositoryId,
      repositoryUrl: "https://cmis.example/browser/A1",
      rootUrl: "https://cmis.example/browser/A1/root",
      credentials: () => ({ authorization: "Bearer installed-consumer-only" }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== "https://cmis.example" || init.redirect !== "manual" || init.credentials !== "omit" ||
          new Headers(init.headers).get("authorization") !== "Bearer installed-consumer-only"
        ) throw new Error("Packed CMIS authority changed");
        const selector = url.searchParams.get("cmisselector");
        if (selector === "repositoryInfo") return new Response(cmisFixture.repository);
        if (selector === "object") return new Response(cmisFixture.object);
        if (selector === "content") {
          return new Response(cmisOriginal, { headers: { "content-length": String(cmisOriginal.length) } });
        }
        throw new Error("Packed CMIS requested an uncaptured operation");
      },
    });
    if (
      (await cmis.repository()).root !== cmisFixture.rootId ||
      (await cmis.get(cmisFixture.objectId)).id !== cmisFixture.objectId
    ) throw new Error("Packed CMIS native identities changed");
    assertBytes(await cmis.read(cmisFixture.objectId), cmisOriginal);
  });
  it("CouchDB native attachments and revision", async () => {
    const couchdbFixture = couchdbInput;
    const couchdbOriginal = Uint8Array.from(atob(couchdbFixture.oracle.base64), (byte) => byte.charCodeAt(0));
    const couchdb = createCouchdbClient({
      endpoint: "https://couchdb.example/",
      database: couchdbFixture.database,
      credentials: () => ({ authorization: "Bearer installed-consumer-only" }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== "https://couchdb.example" || init.redirect !== "manual" || init.credentials !== "omit") {
          throw new Error("Packed CouchDB authority changed");
        }
        const captured = url.searchParams.has("attachments")
          ? couchdbFixture.document
          : init.method === "HEAD"
          ? couchdbFixture.head
          : couchdbFixture.content;
        return new Response(
          init.method === "HEAD" ? null : Uint8Array.from(atob(captured.base64), (byte) => byte.charCodeAt(0)),
          { status: captured.status, headers: captured.headers },
        );
      },
    });
    const couchdbDocument = await couchdb.document(couchdbFixture.documentId);
    if (
      couchdbDocument.id !== couchdbFixture.documentId ||
      couchdbDocument.attachments[0].length !== couchdbOriginal.length
    ) throw new Error("Packed CouchDB native metadata changed");
    assertBytes(
      await couchdb.read(couchdbFixture.documentId, couchdbFixture.attachmentName, {
        revision: couchdbDocument.revision,
      }),
      couchdbOriginal,
    );
    if (
      (await couchdb.stat(couchdbFixture.documentId, couchdbFixture.attachmentName)).etag !==
        couchdbFixture.content.headers.etag
    ) throw new Error("Packed CouchDB attachment ETag changed");
  });
  it("etcd exact keys and revision evidence", async () => {
    const etcdFixture = etcdInput;
    const etcdOriginal = Uint8Array.from(atob(etcdFixture.oracle.base64), (byte) => byte.charCodeAt(0));
    const etcdKey = new TextEncoder().encode(etcdFixture.key);
    const etcd = createEtcdClient({
      endpoint: "https://etcd.example/",
      fetch: async (input, init) => {
        if (
          String(input) !== "https://etcd.example/v3/kv/range" || init.method !== "POST" ||
          init.redirect !== "manual" || init.credentials !== "omit"
        ) throw new Error("Packed etcd authority changed");
        const request = JSON.parse(init.body);
        if (request.key !== btoa(String.fromCharCode(...etcdKey)) || request.serializable !== false) {
          throw new Error("Packed etcd exact key changed");
        }
        return new Response(Uint8Array.from(atob(etcdFixture.range.base64), (byte) => byte.charCodeAt(0)), {
          status: etcdFixture.range.status,
          headers: etcdFixture.range.headers,
        });
      },
    });
    const etcdResult = await etcd.get(etcdKey);
    if (
      !etcdResult.entry || typeof etcdResult.header.cluster_id !== "string" ||
      typeof etcdResult.entry.modRevision !== "string"
    ) throw new Error("Packed etcd revision evidence changed");
    assertBytes(etcdResult.entry.key, etcdKey);
    assertBytes(etcdResult.entry.value, etcdOriginal);
  });
});
