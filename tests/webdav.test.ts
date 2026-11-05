import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createWebdavClient, WebdavPublicationError } from "../src/webdav.ts";
const endpoint = "https://dav.example/root/";
function resource(
  href = "/root/one",
  props = "<d:resourcetype/><d:getcontentlength>3</d:getcontentlength><d:getetag>&quot;one&quot;</d:getetag>",
) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}
function document(content: string) {
  return `<d:multistatus xmlns:d="DAV:">${content}</d:multistatus>`;
}
function client(xml: string) {
  return createWebdavClient({ endpoint, fetch: async () => new Response(xml, { status: 207 }) });
}

describe("WebDAV namespace and path admission", () => {
  for (const style of ["prefix", "default", "nested-default", "split-properties"]) {
    it(`accepts ${style} DAV properties`, async () => {
      let xml = document(resource());
      if (style === "default") xml = xml.replaceAll("d:", "").replace('xmlns:d="DAV:"', 'xmlns="DAV:"');
      if (style === "nested-default") {
        xml = document(
          resource().replace("<d:prop>", '<d:prop xmlns="DAV:">').replaceAll("<d:get", "<get").replaceAll(
            "</d:get",
            "</get",
          ),
        );
      }
      if (style === "split-properties") {
        xml = xml.replace("</d:prop><d:status>", "</d:prop><d:status>").replace(
          "<d:getetag>&quot;one&quot;</d:getetag>",
          "",
        )
          .replace(
            "</d:response>",
            '<d:propstat><d:prop xmlns="DAV:"><getetag>&quot;one&quot;</getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
          );
      }
      expect(await client(xml).stat("/one")).toMatchObject({ path: "/one", kind: "file", size: 3, etag: '"one"' });
    });
  }
  for (
    const href of [
      "https://evil.example/root/one",
      "/other/one",
      "/root/a%2fb",
      "/root/%2e%2e/one",
      "/root/a%5cb",
      "/root/a//b",
      "/root/one?secret=x",
      "/root/a/b",
    ]
  ) {
    it(`refuses escaping or aliased href ${href}`, async () => {
      await expect(client(document(resource(href))).stat("/one")).rejects.toThrow();
    });
  }
  for (
    const props of [
      '<d:resourcetype/><x:getcontentlength xmlns:x="urn:foreign">3</x:getcontentlength>',
      '<d:resourcetype/><getcontentlength xmlns="urn:foreign">3</getcontentlength>',
      '<d:resourcetype/><d:getcontentlength xmlns:d="urn:foreign">3</d:getcontentlength>',
      "<d:resourcetype/><d:wrapper><d:getcontentlength>3</d:getcontentlength></d:wrapper>",
      '<d:resourcetype><x:collection xmlns:x="urn:foreign"/></d:resourcetype><d:getcontentlength>3</d:getcontentlength>',
      "<d:resourcetype/><d:getcontentlength>3</d:getcontentlength><d:getcontentlength>3</d:getcontentlength>",
    ]
  ) {
    it("refuses foreign, rebound, nested or duplicate authority properties", async () => {
      await expect(client(document(resource("/root/one", props))).stat("/one")).rejects.toThrow();
    });
  }
  it("does not expose a partial listing before all child responses pass", async () => {
    const xml = document(
      resource("/root/", "<d:resourcetype><d:collection/></d:resourcetype>") + resource() +
        "<d:response><d:href>/root/two</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>",
    );
    await expect(client(xml).list("/")).rejects.toMatchObject({ status: 403 });
    await expect(client(document(resource() + resource())).stat("/one")).rejects.toThrow(SyntaxError);
  });
  it("follows one exact collection-slash redirect after retiring its body", async () => {
    let requests = 0;
    let retired = 0;
    const native = createWebdavClient({
      endpoint,
      fetch: async (input) => {
        if (++requests === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                retired++;
              },
            }),
            {
              status: 301,
              headers: { location: "/root/dir/" },
            },
          );
        }
        expect(String(input)).toBe(`${endpoint}dir/`);
        return new Response(document(resource("/root/dir/", "<d:resourcetype><d:collection/></d:resourcetype>")), {
          status: 207,
        });
      },
    });
    expect((await native.stat("/dir"))?.kind).toBe("directory");
    expect([requests, retired]).toEqual([2, 1]);
  });
  it("does not forward credentials through arbitrary redirects", async () => {
    let requests = 0;
    const native = createWebdavClient({
      endpoint,
      fetch: async () => {
        requests++;
        return new Response(null, {
          status: 308,
          headers: { location: "https://evil.example/root/one/" },
        });
      },
    });
    await expect(native.stat("/one")).rejects.toThrow(TypeError);
    expect(requests).toBe(1);
  });
  it("reports lost mutation acknowledgement and partial multistatus without replay", async () => {
    for (const response of [undefined, new Response(null, { status: 207 }), new Response(null, { status: 503 })]) {
      let calls = 0;
      const native = createWebdavClient({
        endpoint,
        fetch: async () => {
          calls++;
          if (!response) throw new Error("lost");
          return response;
        },
      });
      await expect(native.put("/one", new Uint8Array([1]))).rejects.toBeInstanceOf(WebdavPublicationError);
      expect(calls).toBe(1);
    }
  });
});

import { createWebdavDriverFromClient } from "../src/driver/webdav.ts";
import { createWebdavAdapter } from "../src/adapter/webdav.ts";
import { createFileSystem } from "../mod.ts";

describe("WebDAV file projection admission", () => {
  it("rejects append/update/stream publication and preserving copy before provider work", async () => {
    let calls = 0;
    const native = createWebdavClient({
      endpoint,
      fetch: async () => {
        calls++;
        throw new Error("No I/O");
      },
    });
    const driver = createWebdavDriverFromClient(native);
    await expect(driver.writeFile("/one", new Uint8Array(), { mode: "append" })).rejects.toMatchObject({
      code: "not-supported",
    });
    await expect(driver.writeFile("/one", new Uint8Array(), { mode: "update" })).rejects.toMatchObject({
      code: "not-supported",
    });
    await expect(driver.copy!("/one", "/two", { overwrite: false })).rejects.toMatchObject({ code: "not-supported" });
    const filesystem = createFileSystem(createWebdavAdapter(native));
    try {
      await expect(filesystem.writeFile("/one", "data", { mode: "append" })).rejects.toMatchObject({
        code: "not-supported",
      });
      expect(calls).toBe(0);
      expect(driver.publication?.copy).toBe("best-effort");
    } finally {
      await filesystem[Symbol.asyncDispose]();
    }
  });
  it("refuses unsafe materialization size before GET and checks exact returned byte extents", async () => {
    let gets = 0;
    const native = createWebdavClient({
      endpoint,
      fetch: async (_input, init) => {
        if (init?.method === "PROPFIND") return new Response(document(resource()), { status: 207 });
        gets++;
        return new Response(new Uint8Array([2, 3]), {
          status: 206,
          headers: { "content-range": "bytes 1-2/3", etag: '"one"' },
        });
      },
    });
    const driver = createWebdavDriverFromClient(native, { maxReadBytes: 2 });
    await expect(driver.readFile("/one")).rejects.toThrow(RangeError);
    expect(gets).toBe(0);
    expect(await driver.readFile("/one", { at: 1, length: 2 })).toEqual(new Uint8Array([2, 3]));
    expect(gets).toBe(1);
  });
});

describe("WebDAV authoritative HTTP source fallback", () => {
  it("does not strengthen a bare DAV property and binds through the independently returned HEAD validator", async () => {
    let heads = 0;
    const native = createWebdavClient({
      endpoint,
      fetch: async (_input, init) => {
        if (init?.method === "PROPFIND") {
          return new Response(document(resource().replace("&quot;one&quot;", "one")), { status: 207 });
        }
        if (init?.method === "HEAD") {
          heads++;
          return new Response(null, { headers: { "content-length": "3", etag: '"http-validator"' } });
        }
        expect(new Headers(init?.headers).get("if-match")).toBe('"http-validator"');
        return new Response(new Uint8Array([1]), {
          status: 206,
          headers: { "content-range": "bytes 0-0/3", etag: '"http-validator"' },
        });
      },
    });
    expect((await native.stat("/one"))?.etag).toBe("one");
    const source = await native.openSource("/one");
    expect(await source.read(0, 1)).toEqual(new Uint8Array([1]));
    expect(heads).toBe(1);
  });
  it("refuses disagreeing HEAD size or missing strong validators", async () => {
    for (const headers of [{ "content-length": "4", etag: '"one"' }, { "content-length": "3", etag: "bare" }]) {
      const native = createWebdavClient({
        endpoint,
        fetch: async (_input, init) =>
          init?.method === "HEAD"
            ? new Response(null, { headers })
            : new Response(document(resource().replace("&quot;one&quot;", "bare")), { status: 207 }),
      });
      await expect(native.openSource("/one")).rejects.toThrow();
    }
  });
  it("retires an invalid redirect URL before exposing parsing failure", async () => {
    let retired = 0;
    const native = createWebdavClient({
      endpoint,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              retired++;
            },
          }),
          {
            status: 301,
            headers: { location: "http://[invalid" },
          },
        ),
    });
    await expect(native.stat("/one")).rejects.toThrow(TypeError);
    expect(retired).toBe(1);
  });
});

describe("WebDAV authenticated replay identity", () => {
  it("omits URL-only replay identity and separates explicit account namespaces", async () => {
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PROPFIND" ? new Response(document(resource()), { status: 207 }) : new Response(null);
    const first = createWebdavClient({ endpoint, fetch });
    expect(first.identity).toBeUndefined();
    expect((await first.openSource("/one")).identity).toBeUndefined();
    const alice = createWebdavClient({ endpoint, fetch, namespace: "alice-account" });
    const bob = createWebdavClient({ endpoint, fetch, namespace: "bob-account" });
    expect((await alice.openSource("/one")).identity).not.toBe((await bob.openSource("/one")).identity);
    expect((await first.openSource("/one", { namespace: "explicit-account" })).identity).toBeDefined();
  });
});

describe("WebDAV canonical removal refusal", () => {
  it("refuses direct-driver and facade removal before any provider work", async () => {
    let calls = 0;
    const native = createWebdavClient({
      endpoint,
      fetch: async () => {
        calls++;
        throw new Error("No I/O");
      },
    });
    await expect(createWebdavDriverFromClient(native).remove("/one")).rejects.toMatchObject({ code: "not-supported" });
    const filesystem = createFileSystem(createWebdavAdapter(native));
    try {
      await expect(filesystem.remove("/one")).rejects.toMatchObject({ code: "not-supported" });
      expect(calls).toBe(0);
    } finally {
      await filesystem[Symbol.asyncDispose]();
    }
  });
});
