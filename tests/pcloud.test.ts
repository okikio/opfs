import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { PcloudClient, PcloudError, PcloudPublicationError } from "../src/pcloud.ts";
import type { FetchType } from "../src/request.ts";

const big = "18446744073709551615";
const wire = (id = "7", size = 4, parent = "0", name = "file.bin"): string =>
  `{"isfolder":false,"id":"f${id}","fileid":${id},"parentfolderid":${parent},"name":${
    JSON.stringify(name)
  },"size":${size},"hash":10681749967730527559}`;
const reply = (value: string): Response => new Response(`{"result":0,${value}}`);
const fileReply = (id = "7", size = 4): Response => reply(`"metadata":${wire(id, size)}`);
const linkReply = (host = "content.example", path = "/secret/file.bin"): Response =>
  reply(`"hosts":[${JSON.stringify(host)}],"path":${JSON.stringify(path)},"expires":1900000000`);
const client = (fetch: FetchType, options: Partial<ConstructorParameters<typeof PcloudClient>[0]> = {}): PcloudClient =>
  new PcloudClient({ endpoint: "https://api.pcloud.com", token: () => "oauth", fetch, ...options });
const route = (input: Parameters<FetchType>[0]): string => new URL(String(input)).pathname;

describe("pCloud native ID client", () => {
  it("preserves uint64 IDs and opaque hashes before JSON number conversion", async () => {
    const api = client((input, init) => {
      expect(route(input)).toBe("/stat");
      expect(new URL(String(input)).search).toBe("");
      const form = init!.body as URLSearchParams;
      expect(form.get("fileid")).toBe(big);
      expect(form.get("access_token")).toBe("oauth");
      for (const key of ["logout", "filtermeta", "filterfilemeta", "filterfoldermeta"]) {
        expect(form.get(key)).toBe(key === "logout" ? "1" : "0");
      }
      expect(form.get("timeformat")).toBe("timestamp");
      expect(init!.credentials).toBe("omit");
      expect(init!.redirect).toBe("manual");
      return Promise.resolve(fileReply(big));
    });
    const stored = await api.statFile(big);
    expect(stored.id).toBe(big);
    expect(stored.hash).toBe("10681749967730527559");
    expect(stored.size).toBe(4);
  });
  it("rejects malformed, duplicate, prototype and excessive lexical JSON fields", async () => {
    const bodies = [
      `{"result":0,"result":0,"metadata":${wire()}}`,
      `{"result":0,"resul\\u0074":0,"metadata":${wire()}}`,
      `{"result":0,"__proto__":{},"metadata":${wire()}}`,
      `{"result":0,"unused":{"constructor":0},"metadata":${wire()}}`,
      `{"result":00,"metadata":${wire()}}`,
      `{"result":0,"unused":${"1".repeat(129)},"metadata":${wire()}}`,
      `{"result":0,"unused":${"[".repeat(34)}0${"]".repeat(34)},"metadata":${wire()}}`,
      `{"result":0,"unused":"${"a".repeat(32769)}","metadata":${wire()}}`,
    ];
    for (const body of bodies) {
      await expect(client(() => Promise.resolve(new Response(body))).statFile("7")).rejects.toThrow();
    }
  });
  it("refuses unsafe sizes, inconsistent identities and native error categories", async () => {
    for (
      const metadata of [
        wire("8"),
        wire().replace('"size":4', '"size":9007199254740993'),
        wire().replace('"id":"f7"', '"id":"d7"'),
      ]
    ) {
      await expect(client(() => Promise.resolve(reply(`"metadata":${metadata}`))).statFile("7")).rejects.toThrow();
    }
    try {
      await client(() => Promise.resolve(new Response('{"result":2009,"error":"secret from server"}'))).statFile("7");
      throw new Error("expected rejection");
    } catch (reason) {
      expect(reason).toBeInstanceOf(PcloudError);
      expect((reason as PcloudError).result).toBe("2009");
      expect(String(reason)).not.toContain("secret");
    }
  });
  it("lists bounded native children while permitting a file and folder with the same name", async () => {
    const folder =
      `{"isfolder":true,"id":"d0","folderid":0,"name":"/","contents":[${wire()}, {"isfolder":true,"id":"d2","folderid":2,"parentfolderid":0,"name":"file.bin"}]}`;
    const api = client(() => Promise.resolve(reply(`"metadata":${folder}`)));
    const listed = await api.listFolder("0");
    expect(listed.entries.map((entry) => entry.kind)).toEqual(["file", "folder"]);
    await expect(client(() => Promise.resolve(reply(`"metadata":${folder}`)), { maxEntries: 1 }).listFolder("0"))
      .rejects.toThrow();
    for (
      const contents of [
        `${wire()},${wire()}`,
        wire("8", 4, "9"),
        `{"isfolder":true,"id":"d2","folderid":2,"parentfolderid":0,"name":"nested","contents":[]}`,
      ]
    ) {
      await expect(
        client(() =>
          Promise.resolve(
            reply(`"metadata":{"isfolder":true,"id":"d0","folderid":0,"name":"/","contents":[${contents}]}`),
          )
        ).listFolder("0"),
      ).rejects.toThrow();
    }
  });
  it("passes explicit revision context without claiming stable byte-source identity", async () => {
    const api = client((_input, init) => {
      expect((init!.body as URLSearchParams).get("revisionid")).toBe(big);
      return Promise.resolve(fileReply());
    });
    expect((await api.statFile("7", { revisionId: big })).id).toBe("7");
  });
  it("validates exact ranges and strips OAuth on all content hops, even the API origin", async () => {
    let tokens = 0, content = 0;
    const api = client((input, init) => {
      if (route(input) === "/stat") return Promise.resolve(fileReply());
      if (route(input) === "/getfilelink") return Promise.resolve(linkReply());
      expect(init!.credentials).toBe("omit");
      expect(init!.redirect).toBe("manual");
      expect(init!.referrerPolicy).toBe("no-referrer");
      expect(new Headers(init!.headers).get("Authorization")).toBeNull();
      expect(init!.body).toBeUndefined();
      expect(new Headers(init!.headers).get("Range")).toBe("bytes=1-2");
      content++;
      return Promise.resolve(
        content === 1
          ? new Response(null, { status: 302, headers: { location: "https://api.pcloud.com/signed/secret" } })
          : new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/4", "content-length": "2" } }),
      );
    }, {
      token: () => {
        tokens++;
        return "oauth";
      },
      downloadOrigins: ["https://content.example", "https://api.pcloud.com"],
    });
    const data = await api.read("7", { at: 1, length: 2 });
    expect(new TextDecoder().decode(data)).toBe("bc");
    expect(tokens).toBe(2);
    expect(content).toBe(2);
  });
  it("never grants an unlisted signed origin or accepts normalized capability paths", async () => {
    for (
      const [host, path] of [["other.example", "/secret"], ["content.example", "/a/../secret"], [
        "content.example",
        "//other.example/secret",
      ], ["evil@content.example", "/secret"]]
    ) {
      let content = 0;
      const api = client((input) => {
        if (route(input) === "/stat") return Promise.resolve(fileReply());
        if (route(input) === "/getfilelink") return Promise.resolve(linkReply(host, path));
        content++;
        return Promise.resolve(new Response("data"));
      }, { downloadOrigins: ["https://content.example"] });
      await expect(api.read("7")).rejects.toThrow();
      expect(content).toBe(0);
    }
  });
  it("checks true EOF and cancels rejected bodies without accepting ignored ranges", async () => {
    for (const mode of ["ignored", "truncated", "extra", "wrong-total", "encoded"]) {
      let cancelled = 0;
      const api = client((input) => {
        if (route(input) === "/stat") return Promise.resolve(fileReply());
        if (route(input) === "/getfilelink") return Promise.resolve(linkReply());
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(mode === "truncated" ? "b" : mode === "extra" ? "bcd" : "bc"));
            if (mode !== "extra") controller.close();
          },
          cancel() {
            cancelled++;
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: mode === "ignored" ? 200 : 206,
            headers: {
              "content-range": mode === "wrong-total" ? "bytes 1-2/5" : "bytes 1-2/4",
              "content-length": "2",
              ...(mode === "encoded" ? { "content-encoding": "gzip" } : {}),
            },
          }),
        );
      }, { downloadOrigins: ["https://content.example"] });
      await expect(api.read("7", { at: 1, length: 2 })).rejects.toThrow();
      if (mode === "extra") expect(cancelled).toBe(1);
    }
  });
  it("owns returned stream cancellation and enforces materialized read admission", async () => {
    let cancelled = 0;
    const api = client((input) => {
      if (route(input) === "/stat") return Promise.resolve(fileReply());
      if (route(input) === "/getfilelink") return Promise.resolve(linkReply());
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-length": "4" } },
        ),
      );
    }, { downloadOrigins: ["https://content.example"], maxBytes: 3 });
    await expect(api.read("7")).rejects.toThrow("budget");
    expect(cancelled).toBe(1);
    const download = await api.download("7");
    await download.bytes.cancel();
    expect(cancelled).toBe(2);
    expect(download.evidence).toBe("server-trusted");
  });
  it("copies upload bytes and native conflict choice before awaiting OAuth", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const options = { conflict: "overwrite" as "overwrite" | "rename" };
    const api = client(async (_input, init) => {
      const form = init!.body as FormData;
      const keys = [...form.keys()];
      expect(keys.at(-1)).toBe("file");
      expect(form.get("renameifexists")).toBeNull();
      expect(form.get("nopartial")).toBe("1");
      expect(new Uint8Array(await (form.get("file") as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
      return reply(`"fileids":[7],"metadata":[${wire()}]`);
    }, {
      token: () => {
        bytes.fill(0);
        options.conflict = "rename";
        return "oauth";
      },
    });
    expect((await api.upload("0", "file.bin", bytes, options)).id).toBe("7");
  });
  it("returns actual rename receipts and refuses ambiguous upload outcomes without retry", async () => {
    const renamed = client((_input, init) => {
      expect((init!.body as FormData).get("renameifexists")).toBe("1");
      return Promise.resolve(reply(`"fileids":[7],"metadata":[${wire("7", 4, "0", "file (2).bin")}]`));
    });
    expect((await renamed.upload("0", "file.bin", new Uint8Array(4), { conflict: "rename" })).name).toBe(
      "file (2).bin",
    );
    for (const mode of ["network", "short", "id", "parent", "missing", "service"]) {
      let calls = 0;
      const api = client(() => {
        calls++;
        if (mode === "network") throw new Error("connection lost");
        return Promise.resolve(
          mode === "service"
            ? new Response('{"result":5001}')
            : mode === "missing"
            ? reply('"fileids":[7],"metadata":[]')
            : reply(
              `"fileids":[7],"metadata":[${
                wire(mode === "id" ? "8" : "7", mode === "short" ? 3 : 4, mode === "parent" ? "9" : "0")
              }]`,
            ),
        );
      });
      await expect(api.upload("0", "file.bin", new Uint8Array(4), { conflict: "overwrite" })).rejects.toBeInstanceOf(
        PcloudPublicationError,
      );
      expect(calls).toBe(1);
    }
  });
  it("distinguishes pre-dispatch token failure from unknown mutation publication", async () => {
    let calls = 0;
    const api = client(() => {
      calls++;
      return Promise.resolve(new Response());
    }, {
      token: () => {
        throw new Error("token unavailable");
      },
    });
    await expect(api.upload("0", "file.bin", new Uint8Array(), { conflict: "overwrite" })).rejects.toThrow(
      "token unavailable",
    );
    expect(calls).toBe(0);
  });
  it("checks create/delete receipts and regional checksum fields", async () => {
    const api = client((input) => {
      if (route(input) === "/createfolder") {
        return Promise.resolve(
          reply('"metadata":{"isfolder":true,"id":"d2","folderid":2,"parentfolderid":0,"name":"folder"}'),
        );
      }
      if (route(input) === "/deletefile") {
        return Promise.resolve(
          reply(`"metadata":${wire().replace('"isfolder":false', '"isfolder":false,"isdeleted":true')}`),
        );
      }
      return Promise.resolve(reply(`"metadata":${wire()},"sha1":"${"a".repeat(40)}","sha256":"${"b".repeat(64)}"`));
    });
    expect((await api.createFolder("0", "folder")).id).toBe("2");
    expect((await api.deleteFile("7")).deleted).toBe(true);
    const checksums = await api.checksumFile("7");
    expect(checksums.sha256).toBe("b".repeat(64));
    expect(checksums.md5).toBeUndefined();
    await expect(client(() => Promise.resolve(fileReply())).deleteFile("7")).rejects.toBeInstanceOf(
      PcloudPublicationError,
    );
  });
  it("redacts native JSON/URL parser context for malformed signed capabilities", async () => {
    for (
      const response of [
        new Response('{"result":0,"hosts":["content.example"],"path":"/secret\\qprivate","expires":1900000000}'),
        linkReply("content.example:99999", "/secret/private"),
      ]
    ) {
      try {
        await client(() => Promise.resolve(response), { downloadOrigins: ["https://content.example"] }).getFileLink(
          "7",
        );
        throw new Error("expected rejection");
      } catch (reason) {
        expect(String(reason)).not.toContain("secret");
        expect(reason).toBeInstanceOf(TypeError);
      }
    }
  });
  it("retains a content extent failure when cancellation also fails", async () => {
    const cleanup = new Error("cancel failed");
    const api = client((input) => {
      if (route(input) === "/stat") return Promise.resolve(fileReply());
      if (route(input) === "/getfilelink") return Promise.resolve(linkReply());
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("abc"));
            },
            cancel() {
              throw cleanup;
            },
          }),
          { status: 206, headers: { "content-range": "bytes 1-2/4", "content-length": "2" } },
        ),
      );
    }, { downloadOrigins: ["https://content.example"] });
    try {
      await api.read("7", { at: 1, length: 2 });
      throw new Error("expected rejection");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      expect((reason as AggregateError).errors[0].message).toContain("extent");
      expect((reason as AggregateError).errors).toContain(cleanup);
    }
  });
  it("rejects invalid authority/names/ranges and zero-length reads need no credentials", async () => {
    expect(() => client(() => Promise.resolve(new Response()), { endpoint: "https://api.pcloud.com/route" })).toThrow();
    let calls = 0;
    const api = client(() => {
      calls++;
      return Promise.resolve(new Response());
    });
    for (const id of ["01", "-1", "18446744073709551616"]) await expect(api.statFile(id)).rejects.toThrow();
    await expect(api.upload("0", "../file", new Uint8Array(), { conflict: "overwrite" })).rejects.toThrow();
    await expect(api.upload("0", "💾".repeat(256), new Uint8Array(), { conflict: "overwrite" })).rejects.toThrow();
    await expect(api.read("7", { at: Number.MAX_SAFE_INTEGER, length: 2 })).rejects.toThrow();
    expect((await api.read("7", { length: 0 })).length).toBe(0);
    expect(calls).toBe(0);
  });
});
