import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { ONEDRIVE_CHUNK_BYTES, OnedriveClient, OnedriveError, OnedrivePublicationError } from "../src/onedrive.ts";
import type { OnedriveUploadType } from "../src/onedrive.ts";
import type { FetchType } from "../src/request.ts";

const expiration = "2030-01-01T00:00:00Z";
const resource = (overrides: Record<string, unknown> = {}) => ({
  id: "item!1",
  name: "file.txt",
  size: 3,
  file: {},
  parentReference: { driveId: "b!drive", id: "parent" },
  ...overrides,
});
const session: OnedriveUploadType = {
  url: "https://upload.invalid/up/secret?signature=secret",
  driveId: "b!drive",
  size: 3,
  target: { kind: "update", itemId: "item!1" },
  expires: expiration,
};
const client = (fetch: FetchType) =>
  new OnedriveClient({
    driveId: "b!drive",
    token: () => "graph-token",
    fetch,
    downloadOrigins: ["https://download.invalid"],
    uploadOrigins: ["https://upload.invalid"],
    uploadPrefixes: ["/up/"],
    request: { retries: 0 },
  });

describe("native OneDrive drive and item authority", () => {
  it("performs no construction I/O and keeps exact optional metadata separate from wire facets", async () => {
    let calls = 0;
    const files = client((input) => {
      calls++;
      expect(new URL(String(input)).pathname).toBe("/v1.0/drives/b!drive/items/item!1");
      return Promise.resolve(Response.json(resource({ parentReference: undefined })));
    });
    expect(calls).toBe(0);
    const found = await files.stat("item!1");
    expect(found.kind).toBe("file");
    expect(Object.hasOwn(found, "etag")).toBe(false);
    expect(Object.hasOwn(found, "driveId")).toBe(false);
    await expect(files.stat("../other")).rejects.toThrow("ID");
    await expect(files.stat("bad\u0000id")).rejects.toThrow("ID");
    await expect(
      client(() => Promise.resolve(Response.json(resource({ size: Number.MAX_SAFE_INTEGER + 1 })))).stat("item!1"),
    ).rejects.toThrow();
    await expect(
      client(() => Promise.resolve(Response.json(resource({ parentReference: { driveId: "other" } })))).stat("item!1"),
    ).rejects.toThrow("identity");
  });
  it("retains repeated names by ID and bounds admitted folder continuation routes", async () => {
    let page = 0;
    const next = "https://graph.microsoft.com/v1.0/drives/b!drive/items/parent/children?$skiptoken=opaque";
    const files = client(() =>
      Promise.resolve(
        Response.json(
          page++ === 0 ? { value: [resource()], "@odata.nextLink": next } : { value: [resource({ id: "second" })] },
        ),
      )
    );
    const found = [];
    for await (const entry of files.list("parent")) found.push(entry);
    expect(found.map((entry) => entry.id)).toEqual(["item!1", "second"]);
    expect(found.map((entry) => entry.name)).toEqual(["file.txt", "file.txt"]);
    for (
      const bad of [
        next.replace("graph.microsoft.com", "foreign.invalid"),
        next.replace("/parent/", "/other/"),
        next + "&access_token=other",
      ]
    ) {
      let tokens = 0;
      const invalid = new OnedriveClient({
        driveId: "b!drive",
        token: () => {
          tokens++;
          return "token";
        },
      });
      await expect(invalid.listPage("parent", { next: bad })).rejects.toThrow();
      expect(tokens).toBe(0);
    }
  });
  it("rejects repeated cursors and page/entry exhaustion without silently restarting", async () => {
    const next = "https://graph.microsoft.com/v1.0/drives/b!drive/root/children?$skiptoken=again";
    const cycle = client(() => Promise.resolve(Response.json({ value: [], "@odata.nextLink": next })));
    await expect(cycle.list("root").next()).rejects.toThrow("repeated");
    const bounded = new OnedriveClient({ driveId: "drive", token: () => "token", maxPages: 0 });
    await expect(bounded.list("root").next()).rejects.toThrow("page budget");
  });
  it("uses fresh download annotations without Graph credentials, cookies or redirects", async () => {
    let tokens = 0;
    let media = 0;
    const files = new OnedriveClient({
      driveId: "b!drive",
      token: () => {
        tokens++;
        return "token";
      },
      downloadOrigins: ["https://download.invalid"],
      fetch: (input, init) => {
        const url = new URL(String(input));
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        const headers = new Headers(init?.headers);
        if (url.origin === "https://graph.microsoft.com") {
          expect(headers.get("authorization")).toBe("Bearer token");
          expect(url.searchParams.get("$select")).toContain("@microsoft.graph.downloadUrl");
          return Promise.resolve(
            Response.json({
              ...resource(),
              "@microsoft.graph.downloadUrl": `https://download.invalid/file?sig=${tokens}`,
            }),
          );
        }
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("range")).toBe("bytes=1-2");
        media++;
        return Promise.resolve(new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/3" } }));
      },
    });
    expect(await new Response(await files.download("item!1", { at: 1, length: 2 })).text()).toBe("bc");
    await (await files.download("item!1", { at: 1, length: 2 })).cancel();
    expect(tokens).toBe(2);
    expect(media).toBe(2);
  });
  it("refuses facet ambiguity and unallowed capability origins before acquiring a media body", async () => {
    for (
      const value of [
        resource({ folder: {} }),
        resource({ remoteItem: {} }),
        resource({ deleted: {} }),
        resource({ file: undefined, package: {} }),
      ]
    ) {
      let calls = 0;
      const files = client(() => {
        calls++;
        return Promise.resolve(
          Response.json({ ...value, "@microsoft.graph.downloadUrl": "https://download.invalid/file" }),
        );
      });
      await expect(files.download("item!1")).rejects.toThrow("regular file");
      expect(calls).toBe(1);
    }
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(
        Response.json({ ...resource(), "@microsoft.graph.downloadUrl": "https://download.invalid.evil.test/file" }),
      );
    });
    await expect(files.download("item!1")).rejects.toThrow("origin");
    expect(calls).toBe(1);
    await new Response(await files.download("item!1", { length: 0 })).text();
    expect(calls).toBe(1);
  });
  it("retires ignored ranges and redirects without following expiring capabilities", async () => {
    let cancelled = false;
    const files = client((input) =>
      Promise.resolve(
        new URL(String(input)).origin === "https://graph.microsoft.com"
          ? Response.json({ ...resource(), "@microsoft.graph.downloadUrl": "https://download.invalid/file" })
          : new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      )
    );
    await expect(files.download("item!1", { at: 1 })).rejects.toThrow("206");
    expect(cancelled).toBe(true);
    let calls = 0;
    const redirect = client(() => {
      calls++;
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://foreign.invalid" } }));
    });
    await expect(redirect.stat("item!1")).rejects.toBeInstanceOf(OnedriveError);
    expect(calls).toBe(1);
  });
  it("maps trash to native recycle-bin DELETE with an explicit item condition", async () => {
    const files = client((_input, init) => {
      expect(init?.method).toBe("DELETE");
      expect(new Headers(init?.headers).get("If-Match")).toBe('"tag"');
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await files.trash("item!1", { ifMatch: '"tag"' });
  });
});

describe("native OneDrive upload recovery", () => {
  it("creates a native parent/name session with explicit fail-on-conflict policy", async () => {
    const files = client((input, init) => {
      expect(new URL(String(input)).pathname).toBe("/v1.0/drives/b!drive/items/parent:/file.txt:/createUploadSession");
      expect(JSON.parse(String(init?.body))).toEqual({
        item: { name: "file.txt", "@microsoft.graph.conflictBehavior": "fail" },
        deferCommit: false,
      });
      return Promise.resolve(Response.json({ uploadUrl: session.url, expirationDateTime: expiration }));
    });
    expect(
      (await files.createUpload({ size: 3, target: { kind: "create", parentId: "parent", name: "file.txt" } })).size,
    ).toBe(3);
    await expect(files.createUpload({ size: 0, target: { kind: "update", itemId: "item!1" } })).rejects.toThrow(
      "positive size",
    );
  });
  it("keeps sparse/partial missing ranges and empty lists separate from complete publication", async () => {
    let page = 0;
    const files = client((_input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.credentials).toBe("omit");
      return Promise.resolve(
        Response.json({ expirationDateTime: expiration, nextExpectedRanges: page++ === 0 ? ["0-1", "2-"] : [] }),
      );
    });
    expect(await files.queryUpload(session)).toEqual({
      complete: false,
      missing: [{ start: 0, end: 1 }, { start: 2 }],
      expires: expiration,
    });
    expect(await files.queryUpload(session)).toEqual({ complete: false, missing: [], expires: expiration });
    for (const value of ["3-", "2-1", "9007199254740992-", "-1-2"]) {
      await expect(
        client(() => Promise.resolve(Response.json({ expirationDateTime: expiration, nextExpectedRanges: [value] })))
          .queryUpload(session),
      ).rejects.toThrow();
    }
  });
  it("admits restored session origins and upload path bounds before any token or dispatch", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      throw new Error("unexpected");
    });
    for (
      const url of [
        "https://upload.invalid.evil.test/up/secret",
        "https://upload.invalid/other/secret",
        "https://upload.invalid/up/%252e%252e/secret",
        "https://upload.invalid/up/%2fother/secret",
        "https://graph.microsoft.com/v1.0/arbitrary",
        "http://upload.invalid/up/secret",
        "https://user:pass@upload.invalid/up/secret",
      ]
    ) {
      await expect(files.queryUpload({ ...session, url })).rejects.toThrow();
    }
    await expect(files.queryUpload({ ...session, driveId: "other" })).rejects.toThrow("another drive");
    expect(calls).toBe(0);
  });
  it("enforces nonfinal fragment alignment and copies caller native bytes before awaits", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(Response.json(resource()));
    });
    await expect(files.writeUpload({ ...session, size: ONEDRIVE_CHUNK_BYTES + 1 }, 0, new Uint8Array(1))).rejects
      .toThrow("extent");
    await expect(files.writeUpload(session, 0, {} as Uint8Array)).rejects.toThrow("Uint8Array");
    expect(calls).toBe(0);
    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytes, "byteLength", { value: 99999 });
    const upload = { ...session };
    const pending = new OnedriveClient({
      driveId: "b!drive",
      token: () => {
        throw new Error("upload must not acquire Graph token");
      },
      uploadOrigins: ["https://upload.invalid"],
      fetch: async (input, init) => {
        await Promise.resolve();
        expect(String(input)).toBe(session.url);
        expect(Array.from(init?.body as Uint8Array)).toEqual([1, 2, 3]);
        expect(new Headers(init?.headers).get("content-range")).toBe("bytes 0-2/3");
        return Response.json(resource());
      },
    }).writeUpload(upload, 0, bytes);
    bytes.fill(9);
    upload.size = 10;
    upload.url = "https://foreign.invalid";
    expect((await pending).complete).toBe(true);
  });
  it("requires full final receipt attribution and never substitutes later metadata", async () => {
    for (
      const invalid of [
        resource({ id: "other" }),
        resource({ size: 2 }),
        resource({ folder: {} }),
        resource({ parentReference: { driveId: "other" } }),
        {},
      ]
    ) {
      await expect(client(() => Promise.resolve(Response.json(invalid))).writeUpload(session, 0, new Uint8Array(3)))
        .rejects.toBeInstanceOf(OnedrivePublicationError);
    }
    const create = {
      ...session,
      target: { kind: "create", parentId: "parent", name: "file.txt", conflict: "fail" } as const,
    };
    await expect(
      client(() => Promise.resolve(Response.json(resource({ name: "other.txt" })))).writeUpload(
        create,
        0,
        new Uint8Array(3),
      ),
    ).rejects.toBeInstanceOf(OnedrivePublicationError);
    const staged = client(() =>
      Promise.resolve(Response.json({ expirationDateTime: expiration, nextExpectedRanges: [] }, { status: 202 }))
    );
    expect((await staged.writeUpload(session, 0, new Uint8Array(3))).complete).toBe(false);
    const total = ONEDRIVE_CHUNK_BYTES + 1;
    const premature = client(() => Promise.resolve(Response.json(resource({ size: total }))));
    await expect(premature.writeUpload({ ...session, size: total }, 0, new Uint8Array(ONEDRIVE_CHUNK_BYTES))).rejects
      .toBeInstanceOf(OnedrivePublicationError);
  });
  it("keeps lost-final and expired sessions unknown instead of recreating or replaying", async () => {
    let calls = 0;
    const files = new OnedriveClient({
      driveId: "b!drive",
      token: () => "token",
      uploadOrigins: ["https://upload.invalid"],
      request: { retries: 3 },
      fetch: () => {
        calls++;
        throw new Error("lost final acknowledgement");
      },
    });
    await expect(files.writeUpload(session, 0, new Uint8Array(3))).rejects.toBeInstanceOf(OnedrivePublicationError);
    expect(calls).toBe(1);
    const expired = client(() => Promise.resolve(new Response(null, { status: 404 })));
    await expect(expired.queryUpload(session)).rejects.toBeInstanceOf(OnedriveError);
    const noAuth = new OnedriveClient({
      driveId: "drive",
      token: () => {
        throw new Error("auth failed before dispatch");
      },
    });
    await expect(noAuth.trash("file")).rejects.toThrow("auth failed before dispatch");
  });
  it("cancels temporary session state separately from recycling a published item", async () => {
    const files = client((_input, init) => {
      expect(init?.method).toBe("DELETE");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await files.cancelUpload(session);
  });
});
