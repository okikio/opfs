import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { DRIVE_CHUNK_BYTES, DriveClient, DriveError, DrivePublicationError } from "../src/drive.ts";
import type { FetchType } from "../src/request.ts";

const resource = (overrides: Record<string, unknown> = {}) => ({
  id: "file1",
  name: "same.txt",
  mimeType: "text/plain",
  size: "3",
  ...overrides,
});
const session = {
  url: "https://www.googleapis.com/upload/drive/v3/files/file1?uploadType=resumable&upload_id=secret",
  size: 3,
  fileId: "file1",
};
const client = (fetch: FetchType) => new DriveClient({ token: () => "test", fetch, request: { retries: 0 } });

describe("native Google Drive IDs and authority", () => {
  it("omits absent optional metadata from the public exact-optional shape", async () => {
    const files = client(() =>
      Promise.resolve(Response.json({ id: "file1", name: "folder", mimeType: "application/vnd.google-apps.folder" }))
    );
    expect(await files.stat("file1")).toEqual({
      id: "file1",
      name: "folder",
      mimeType: "application/vnd.google-apps.folder",
    });
    expect(Object.hasOwn(await files.stat("file1"), "size")).toBe(false);
  });
  it("has no construction effects and rejects unsafe sizes and different receipts", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(Response.json(resource({ size: "9007199254740992" })));
    });
    expect(calls).toBe(0);
    await expect(files.stat("file1")).rejects.toThrow("file size");
    await expect(client(() => Promise.resolve(Response.json(resource()))).stat("other")).rejects.toThrow(
      "another file",
    );
    await expect(files.stat("../file")).rejects.toThrow("ID");
    expect(calls).toBe(1);
  });
  it("preserves duplicate names and selects the explicit shared-drive corpus", async () => {
    let page = 0;
    const files = client((input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("corpora")).toBe("drive");
      expect(url.searchParams.get("driveId")).toBe("team");
      expect(url.searchParams.get("q")).toBe("trashed = false and 'root' in parents");
      return Promise.resolve(
        Response.json(
          page++ === 0 ? { files: [resource()], nextPageToken: "next" } : { files: [resource({ id: "file2" })] },
        ),
      );
    });
    const found = [];
    for await (const entry of files.list({ sharedDriveId: "team", parent: "root" })) found.push(entry);
    expect(found.map((entry) => entry.id)).toEqual(["file1", "file2"]);
    expect(found.map((entry) => entry.name)).toEqual(["same.txt", "same.txt"]);
  });
  it("rejects incomplete searches, cursor cycles and page budgets", async () => {
    const incomplete = client(() => Promise.resolve(Response.json({ files: [], incompleteSearch: true })));
    await expect(incomplete.list().next()).rejects.toThrow("incomplete");
    const cycle = client(() => Promise.resolve(Response.json({ files: [], nextPageToken: "same" })));
    const iterator = cycle.list();
    await expect(iterator.next()).rejects.toThrow("repeated");
    const bound = new DriveClient({
      token: () => "test",
      maxPages: 1,
      fetch: () => Promise.resolve(Response.json({ files: [], nextPageToken: "next" })),
    });
    await expect(bound.list().next()).rejects.toThrow("page budget");
  });
  it("does not pretend Workspace export is a stored ranged download", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(Response.json(resource({ mimeType: "application/vnd.google-apps.document" })));
    });
    await expect(files.download("file1")).rejects.toThrow("export");
    expect(calls).toBe(1);
    await new Response(await files.download("file1", { length: 0 })).text();
    expect(calls).toBe(1);
  });
  it("admits exact media range evidence and cancels ignored range bodies", async () => {
    const files = client((input, init) => {
      const url = new URL(String(input));
      if (url.searchParams.get("alt") !== "media") return Promise.resolve(Response.json(resource()));
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-2");
      return Promise.resolve(new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/3" } }));
    });
    expect(await new Response(await files.download("file1", { at: 1, length: 2 })).text()).toBe("bc");
    let cancelled = false;
    const ignored = client((input) =>
      Promise.resolve(
        new URL(String(input)).searchParams.has("alt")
          ? new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          )
          : Response.json(resource()),
      )
    );
    await expect(ignored.download("file1", { at: 1 })).rejects.toThrow("206");
    expect(cancelled).toBe(true);
  });
  it("admits restored session routes before acquiring credentials and never follows redirects", async () => {
    let tokens = 0;
    const files = new DriveClient({
      token: () => {
        tokens++;
        return "test";
      },
      fetch: (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://foreign.invalid" } }));
      },
      request: { retries: 0 },
    });
    await expect(files.queryUpload({ ...session, url: session.url.replace("www.googleapis.com", "foreign.invalid") }))
      .rejects.toThrow("route");
    expect(tokens).toBe(0);
    await expect(files.stat("file1")).rejects.toBeInstanceOf(DriveError);
    expect(tokens).toBe(1);
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    await expect(files.stat("file1", aborted.signal)).rejects.toThrow("stop");
    expect(tokens).toBe(1);
  });
  it("keeps trash and permanent delete separate, including folder delete authority", async () => {
    const methods: string[] = [];
    const files = client((_input, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      expect(JSON.parse(String(init?.body))).toEqual({ trashed: true });
      return Promise.resolve(Response.json(resource({ trashed: true })));
    });
    expect((await files.trash("file1")).trashed).toBe(true);
    await files.remove("file1");
    expect(methods).toEqual(["PATCH", "DELETE"]);
  });
});

describe("Drive resumable publication", () => {
  it("rejects duplicate query authority and alternate credential channels before OAuth", async () => {
    let tokens = 0;
    const files = new DriveClient({
      token: () => {
        tokens++;
        return "token";
      },
      fetch: () => {
        throw new Error("unexpected dispatch");
      },
    });
    for (
      const suffix of ["&access_token=secret", "&key=secret", "&uploadType=media", "&upload_id=other", "&alt=media"]
    ) {
      await expect(files.queryUpload({ ...session, url: session.url + suffix })).rejects.toThrow("query fields");
    }
    await expect(files.createUpload({ size: 3, fileId: "root", mimeType: "text/plain" })).rejects.toThrow("root");
    await expect(files.createUpload({ size: 3, name: "doc", mimeType: "Application/Vnd.Google-Apps.Document" })).rejects
      .toThrow("export");
    expect(tokens).toBe(0);
  });
  it("pins the admitted session and byte extent through an asynchronous token wait", async () => {
    const upload = { ...session };
    const bytes = new Uint8Array([1, 2, 3]);
    let release: ((token: string) => void) | undefined;
    const files = new DriveClient({
      token: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      fetch: (input, init) => {
        expect(String(input)).toBe(session.url);
        expect(new Headers(init?.headers).get("content-range")).toBe("bytes 0-2/3");
        expect(Array.from(init?.body as Uint8Array)).toEqual([1, 2, 3]);
        return Promise.resolve(Response.json(resource()));
      },
    });
    const pending = files.writeUpload(upload, 0, bytes);
    upload.url = "https://foreign.invalid";
    upload.fileId = "wrong";
    upload.size = 9;
    bytes.fill(9);
    expect(typeof release).toBe("function");
    release!("token");
    expect((await pending).complete).toBe(true);
  });
  it("forwards active cancellation to Fetch and bounds malformed acknowledged extents", async () => {
    const controller = new AbortController();
    let observed = false;
    const files = client((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observed = true;
          reject(init.signal?.reason);
        }, { once: true });
        queueMicrotask(() => controller.abort(new Error("cancelled request")));
      })
    );
    let failure: unknown;
    try {
      await files.stat("file1", controller.signal);
    } catch (cause) {
      failure = cause;
    }
    expect(failure instanceof AggregateError ? failure.errors : [failure]).toContain(controller.signal.reason);
    expect(observed).toBe(true);
    for (const value of ["bytes=1-2", "bytes=0-9007199254740992", "bytes=0-3"]) {
      const invalid = client(() => Promise.resolve(new Response(null, { status: 308, headers: { range: value } })));
      await expect(invalid.queryUpload(session)).rejects.toThrow();
    }
  });
  it("creates a fixed-size session and preserves returned upload authority", async () => {
    const files = client((input, init) => {
      expect(new URL(String(input)).searchParams.get("uploadType")).toBe("resumable");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-upload-content-length")).toBe("3");
      return Promise.resolve(new Response(null, { headers: { location: session.url.replace("/file1?", "?") } }));
    });
    expect(await files.createUpload({ name: "same.txt", mimeType: "text/plain", size: 3 })).toEqual({
      url: session.url.replace("/file1?", "?"),
      size: 3,
    });
  });
  it("reconciles absent and partial acknowledgements, independently from completion", async () => {
    let page = 0;
    const files = client((_input, init) => {
      expect(new Headers(init?.headers).get("content-range")).toBe("bytes */3");
      return Promise.resolve(
        page++ === 0
          ? new Response(null, { status: 308 })
          : new Response(null, { status: 308, headers: { range: "bytes=0-2" } }),
      );
    });
    expect(await files.queryUpload(session)).toEqual({ complete: false, offset: 0 });
    expect(await files.destination(session).status()).toEqual({ complete: false, offset: 3, size: 3 });
  });
  it("requires ID and size receipts, and treats malformed final acknowledgements as uncertain", async () => {
    const good = client((_input, init) => {
      expect(new Headers(init?.headers).get("content-range")).toBe("bytes 0-2/3");
      return Promise.resolve(Response.json(resource()));
    });
    expect((await good.writeUpload(session, 0, new TextEncoder().encode("abc"))).complete).toBe(true);
    for (const invalid of [resource({ size: "2" }), resource({ id: "wrong" }), {}]) {
      await expect(client(() => Promise.resolve(Response.json(invalid))).writeUpload(session, 0, new Uint8Array(3)))
        .rejects.toBeInstanceOf(DrivePublicationError);
    }
  });
  it("rejects invalid extents before I/O and snapshots native byte slots before token awaits", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(Response.json(resource()));
    });
    await expect(files.writeUpload({ ...session, size: DRIVE_CHUNK_BYTES + 10 }, 0, new Uint8Array(1))).rejects.toThrow(
      "extent",
    );
    await expect(files.writeUpload(session, 0, {} as Uint8Array)).rejects.toThrow("Uint8Array");
    expect(calls).toBe(0);
    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytes, "byteLength", { value: 1000000000 });
    const snapshot = new DriveClient({
      token: () => {
        bytes.fill(9);
        return "test";
      },
      fetch: (_input, init) => {
        expect(Array.from(init?.body as Uint8Array)).toEqual([1, 2, 3]);
        return Promise.resolve(Response.json(resource()));
      },
    });
    expect((await snapshot.writeUpload(session, 0, bytes)).complete).toBe(true);
  });
  it("never restarts an expired session or retries uncertain writes", async () => {
    let calls = 0;
    const expired = client(() => {
      calls++;
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    await expect(expired.queryUpload(session)).rejects.toBeInstanceOf(DriveError);
    expect(calls).toBe(1);
    const uncertain = new DriveClient({
      token: () => "test",
      request: { retries: 3 },
      fetch: () => {
        calls++;
        throw new Error("lost acknowledgement");
      },
    });
    await expect(uncertain.writeUpload(session, 0, new Uint8Array(3))).rejects.toBeInstanceOf(DrivePublicationError);
    expect(calls).toBe(2);
  });
});
