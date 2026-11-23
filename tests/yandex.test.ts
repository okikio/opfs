import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { YandexClient, YandexPublicationError } from "../src/yandex.ts";
import type { FetchType } from "../src/request.ts";
const apiBase = "https://cloud-api.yandex.net/v1/disk/";
const file = (path = "disk:/file.bin", size = 4): object => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  type: "file",
  size,
  md5: "a".repeat(32),
});
const link = (href: string, method = "GET"): Response => Response.json({ href, method, templated: false });
const client = (fetch: FetchType, options: Partial<ConstructorParameters<typeof YandexClient>[0]> = {}): YandexClient =>
  new YandexClient({ fetch, token: () => "token", ...options });
const route = (input: Parameters<FetchType>[0]): URL => new URL(String(input));
const operation = { id: "operation_1", href: apiBase + "operations/operation_1" };

describe("Yandex Disk native REST", () => {
  it("encodes literal native paths once and returns server metadata without revision claims", async () => {
    const api = client((input, init) => {
      expect(route(input).searchParams.get("path")).toBe("disk:/a%2Fb");
      expect(route(input).search).toContain("%252F");
      expect(new Headers(init!.headers).get("Authorization")).toBe("OAuth token");
      expect(init!.credentials).toBe("omit");
      expect(init!.redirect).toBe("manual");
      return Promise.resolve(Response.json(file("disk:/a%2Fb")));
    });
    expect((await api.stat("disk:/a%2Fb")).path).toBe("disk:/a%2Fb");
  });
  it("refuses alias paths, root mutations, unsafe numbers and duplicate authority JSON", async () => {
    let calls = 0;
    const api = client(() => {
      calls++;
      return Promise.resolve(new Response());
    });
    for (
      const path of ["/file", "app:/file", "disk:/a/../file", "disk:/a//file", "disk:/back\\slash", "disk:/nul\0name"]
    ) await expect(api.stat(path)).rejects.toThrow();
    await expect(api.deleteResource("disk:/", { recursive: true, permanently: false })).rejects.toThrow("root");
    await expect(api.copy("disk:/", "disk:/target", { overwrite: false })).rejects.toThrow("root");
    expect(calls).toBe(0);
    for (
      const body of [
        '{"path":"disk:/file.bin","path":"disk:/file.bin","name":"file.bin","type":"file","size":4}',
        '{"path":"disk:/file.bin","name":"file.bin","type":"file","size":9007199254740991.1}',
        '{"path":"disk:/file.bin","name":"file.bin","type":"file","size":9007199254740993}',
        '{"path":"disk:/file.bin","name":"file.bin","type":"file","size":4,"__proto__":{}}',
      ]
    ) await expect(client(() => Promise.resolve(new Response(body))).stat("disk:/file.bin")).rejects.toThrow();
  });
  it("validates offset pages, direct children and progress without implying an atomic snapshot", async () => {
    let calls = 0;
    const api = client((input) => {
      const offset = Number(route(input).searchParams.get("offset"));
      calls++;
      return Promise.resolve(
        Response.json({
          path: "disk:/folder",
          name: "folder",
          type: "dir",
          _embedded: {
            path: "disk:/folder",
            offset,
            limit: 100,
            total: 2,
            items: [file(offset ? "disk:/folder/b" : "disk:/folder/a")],
          },
        }),
      );
    });
    expect((await api.list("disk:/folder")).map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(calls).toBe(2);
    for (const mutation of ["offset", "parent", "empty", "repeat"]) {
      const api = client((input) => {
        const offset = Number(route(input).searchParams.get("offset"));
        return Promise.resolve(
          Response.json({
            path: "disk:/folder",
            name: "folder",
            type: "dir",
            _embedded: {
              path: "disk:/folder",
              offset: mutation === "offset" ? offset + 1 : offset,
              limit: 100,
              total: 2,
              items: mutation === "empty" ? [] : [file(mutation === "parent" ? "disk:/elsewhere/a" : "disk:/folder/a")],
            },
          }),
        );
      }, { maxPages: 3 });
      await expect(api.list("disk:/folder")).rejects.toThrow();
    }
  });
  it("captures one operation token for initial download and strips it permanently on redirect", async () => {
    let tokens = 0, hops = 0;
    const api = client((input, init) => {
      const target = route(input), headers = new Headers(init!.headers);
      if (target.pathname.endsWith("/resources")) return Promise.resolve(Response.json(file()));
      if (target.pathname.endsWith("/resources/download")) {
        expect(headers.get("Authorization")).toBe("OAuth token1");
        return Promise.resolve(link("https://download.example/secret"));
      }
      hops++;
      expect(init!.credentials).toBe("omit");
      expect(init!.referrerPolicy).toBe("no-referrer");
      expect(headers.get("Range")).toBe("bytes=1-2");
      expect(headers.get("Authorization")).toBe(hops === 1 ? "OAuth token1" : null);
      expect(headers.get("Accept")).toBeNull();
      return Promise.resolve(
        hops === 1
          ? new Response(null, { status: 302, headers: { location: "https://download.example/again" } })
          : hops === 2
          ? new Response(null, { status: 302, headers: { location: apiBase + "signed/secret" } })
          : new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/4", "content-length": "2" } }),
      );
    }, {
      token: () => `token${++tokens}`,
      downloadOrigins: ["https://download.example", "https://cloud-api.yandex.net"],
      downloadAuthOrigins: ["https://download.example", "https://cloud-api.yandex.net"],
    });
    expect(new TextDecoder().decode(await api.read("disk:/file.bin", { at: 1, length: 2 }))).toBe("bc");
    expect(tokens).toBe(1);
    expect(hops).toBe(3);
  });
  it("requires a separate OAuth origin grant before fetching content", async () => {
    let content = 0;
    const api = client((input) => {
      if (route(input).pathname.endsWith("/resources")) return Promise.resolve(Response.json(file()));
      if (route(input).pathname.endsWith("/resources/download")) {
        return Promise.resolve(link("https://download.example/secret"));
      }
      content++;
      return Promise.resolve(new Response());
    }, { downloadOrigins: ["https://download.example"] });
    await expect(api.read("disk:/file.bin")).rejects.toThrow("OAuth origin");
    expect(content).toBe(0);
    expect(() => client(() => Promise.resolve(new Response()), { downloadAuthOrigins: ["https://download.example"] }))
      .toThrow("content-origin");
  });
  it("rejects ignored, encoded, truncated and oversized range bodies", async () => {
    for (const mode of ["ignored", "encoded", "short", "extra", "total"]) {
      const api = client((input) => {
        if (route(input).pathname.endsWith("/resources")) return Promise.resolve(Response.json(file()));
        if (route(input).pathname.endsWith("/resources/download")) {
          return Promise.resolve(link("https://download.example/secret"));
        }
        return Promise.resolve(
          new Response(mode === "short" ? "b" : mode === "extra" ? "bcd" : "bc", {
            status: mode === "ignored" ? 200 : 206,
            headers: {
              "content-range": mode === "total" ? "bytes 1-2/5" : "bytes 1-2/4",
              "content-length": "2",
              ...(mode === "encoded" ? { "content-encoding": "gzip" } : {}),
            },
          }),
        );
      }, { downloadOrigins: ["https://download.example"], downloadAuthOrigins: ["https://download.example"] });
      await expect(api.read("disk:/file.bin", { at: 1, length: 2 })).rejects.toThrow();
    }
  });
  it("preflights buffered reads before content and transfers cancellation ownership", async () => {
    let content = 0, cancels = 0;
    const fetch: FetchType = (input) => {
      if (route(input).pathname.endsWith("/resources")) return Promise.resolve(Response.json(file()));
      if (route(input).pathname.endsWith("/resources/download")) {
        return Promise.resolve(link("https://download.example/secret"));
      }
      content++;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancels++;
            },
          }),
          { headers: { "content-length": "4" } },
        ),
      );
    };
    const api = client(fetch, {
      maxBytes: 3,
      downloadOrigins: ["https://download.example"],
      downloadAuthOrigins: ["https://download.example"],
    });
    await expect(api.read("disk:/file.bin")).rejects.toThrow("budget");
    expect(content).toBe(0);
    const download = await api.download("disk:/file.bin");
    await download.bytes.cancel();
    expect(cancels).toBe(1);
    expect(download.evidence).toBe("server-trusted");
  });
  it("snapshots upload bytes/target settings and never sends OAuth to the uploader", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]), options = { overwrite: false };
    const api = client((input, init) => {
      if (route(input).pathname.endsWith("/resources/upload")) {
        expect(route(input).searchParams.get("overwrite")).toBe("false");
        return Promise.resolve(link("https://upload.example/secret", "PUT"));
      }
      expect(new Headers(init!.headers).get("Authorization")).toBeNull();
      expect(new Headers(init!.headers).get("Content-Type")).toBe("application/octet-stream");
      expect(init!.body).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(init!.redirect).toBe("manual");
      return Promise.resolve(new Response(null, { status: 201 }));
    }, {
      token: () => {
        bytes.fill(0);
        options.overwrite = true;
        return "token";
      },
      uploadOrigins: ["https://upload.example"],
    });
    expect(await api.upload("disk:/file.bin", bytes, options)).toEqual({
      state: "created",
      path: "disk:/file.bin",
      size: 4,
      acknowledgment: "http-201",
    });
  });
  it("keeps upload202 pending without inventing an operation link and never retries PUT", async () => {
    for (const status of [202, 307, 500]) {
      let puts = 0;
      const api = client((input) => {
        if (route(input).pathname.endsWith("/resources/upload")) {
          return Promise.resolve(link("https://upload.example/secret", "PUT"));
        }
        puts++;
        return Promise.resolve(new Response(null, { status }));
      }, { uploadOrigins: ["https://upload.example"] });
      if (status === 202) {
        expect(await api.upload("disk:/file.bin", new Uint8Array(), { overwrite: false })).toEqual({
          state: "pending",
          path: "disk:/file.bin",
          size: 0,
          acknowledgment: "http-202",
        });
      } else {await expect(api.upload("disk:/file.bin", new Uint8Array(), { overwrite: false })).rejects.toBeInstanceOf(
          YandexPublicationError,
        );}
      expect(puts).toBe(1);
    }
  });
  it("distinguishes native completed receipts and asynchronous copy/move/delete", async () => {
    const api = client((input, init) => {
      if (init!.method === "PUT") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ href: apiBase + "resources?path=disk%3A%2Ffolder", method: "GET", templated: false }),
            { status: 201 },
          ),
        );
      }
      if (route(input).pathname.endsWith("/operations/operation_1")) {
        return Promise.resolve(Response.json({ status: "success" }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ href: operation.href, method: "GET", templated: false }), { status: 202 }),
      );
    });
    expect((await api.createFolder("disk:/folder")).state).toBe("completed");
    const copy = await api.copy("disk:/from", "disk:/to", { overwrite: false });
    expect(copy.state).toBe("pending");
    expect(copy.from).toBe("disk:/from");
    if (copy.state !== "pending") throw new Error("expected pending");
    expect(await api.statusOperation(copy.operation)).toBe("success");
    expect((await api.move("disk:/from", "disk:/to", { overwrite: true })).state).toBe("pending");
    expect((await api.deleteResource("disk:/to", { recursive: true, permanently: false })).state).toBe("pending");
    expect(
      (await client(() => Promise.resolve(new Response(null, { status: 204 }))).deleteResource("disk:/to", {
        recursive: true,
        permanently: true,
      })).state,
    ).toBe("completed");
  });
  it("validates operation authority, routes, sole ID query and native status values", async () => {
    let calls = 0;
    const api = client(() => {
      calls++;
      return Promise.resolve(Response.json({ status: "in-progress" }));
    });
    expect(await api.statusOperation({ id: "operation_1", href: apiBase + "operations?id=operation_1" })).toBe(
      "in-progress",
    );
    for (
      const href of [
        "https://evil.example/v1/disk/operations/operation_1",
        apiBase + "resources?id=operation_1",
        apiBase + "operations?id=operation_1&extra=1",
        apiBase + "operations?id=operation_1&id=operation_1",
        apiBase + "operations/operation_1?x=1",
        apiBase + "operations/a%2Fb",
      ]
    ) await expect(api.statusOperation({ id: "operation_1", href })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(await client(() => Promise.resolve(Response.json({ status: "failed" }))).statusOperation(operation)).toBe(
      "failed",
    );
  });
  it("reports unknown outcomes for malformed metadata/operation receipts and network loss", async () => {
    for (const mode of ["authority", "target", "template", "network"]) {
      let calls = 0;
      const api = client(() => {
        calls++;
        if (mode === "network") throw new Error("connection lost");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              href: mode === "authority"
                ? "https://evil.example/operations/a"
                : apiBase + "resources?path=disk%3A%2Fwrong",
              method: "GET",
              templated: mode === "template",
            }),
            { status: mode === "authority" ? 202 : 201 },
          ),
        );
      });
      await expect(api.copy("disk:/from", "disk:/to", { overwrite: false })).rejects.toBeInstanceOf(
        YandexPublicationError,
      );
      expect(calls).toBe(1);
    }
  });
  it("local empty reads and rejected deletion admission perform no credential or network IO", async () => {
    let calls = 0;
    const api = client(() => {
      calls++;
      return Promise.resolve(new Response());
    }, {
      token: () => {
        calls++;
        return "token";
      },
    });
    expect(await api.read("disk:/file.bin", { length: 0 })).toEqual(new Uint8Array());
    await expect(api.deleteResource("disk:/file.bin", { recursive: false as unknown as true, permanently: false }))
      .rejects.toThrow();
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await expect(api.stat("disk:/file.bin", abort.signal)).rejects.toThrow("stop");
    expect(calls).toBe(0);
  });
  it("does not promote an undocumented asynchronous folder-create response to a valid receipt", async () => {
    const api = client(() =>
      Promise.resolve(
        new Response(JSON.stringify({ href: operation.href, method: "GET", templated: false }), { status: 202 }),
      )
    );
    await expect(api.createFolder("disk:/folder")).rejects.toBeInstanceOf(YandexPublicationError);
  });
});
