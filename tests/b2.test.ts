import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { authorizeB2, B2PublicationError, createB2Client } from "../src/b2.ts";
import type { B2FileType } from "../src/b2.ts";
import type { FetchType } from "../src/request.ts";
import { createB2DriverFromClient } from "../src/driver/b2.ts";
import { createB2Adapter } from "../src/adapter/b2.ts";
import { openObjectSource } from "../src/source.ts";

const auth = {
  accountId: "account",
  authorizationToken: "account-secret",
  apiUrl: "https://api.example.test",
  downloadUrl: "https://download.example.test",
};
// SHA1 is the published FIPS 180-1/180-2 'abc' known answer, not computed by the client under test.
const abcSha1 = "a9993e364706816aba3e25717850c26c9cd0d89d";
const file: B2FileType = {
  fileId: "4_z-opaque",
  fileName: "dir/a?.bin",
  bucketId: "bucket",
  action: "upload",
  contentLength: 3,
  contentSha1: abcSha1,
  contentType: "application/octet-stream",
  uploadTimestamp: 1,
  fileInfo: {},
};
function client(fetch: FetchType, maxUploadBytes?: number) {
  return createB2Client({
    authorization: auth,
    bucketId: "bucket",
    fetch,
    subtle: globalThis.crypto.subtle,
    ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
  });
}
function media(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {
      "x-bz-file-id": file.fileId,
      "x-bz-file-name": encodeURIComponent(file.fileName),
      "content-length": String(body.length),
      ...extra,
    },
  });
}

describe("B2 native protocol", () => {
  it("authorizes v4 explicitly without connecting on client construction", async () => {
    let calls = 0;
    const authorization = await authorizeB2({
      applicationKeyId: "id",
      applicationKey: "key",
      fetch: async (input, init) => {
        calls++;
        expect(String(input)).toBe("https://api.backblazeb2.com/b2api/v4/b2_authorize_account");
        expect(new Headers(init?.headers).get("authorization")).toBe("Basic aWQ6a2V5");
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        return Response.json({
          accountId: auth.accountId,
          authorizationToken: auth.authorizationToken,
          apiInfo: { storageApi: { apiUrl: auth.apiUrl, downloadUrl: auth.downloadUrl } },
        });
      },
    });
    expect(authorization).toEqual(auth);
    client(async () => {
      calls++;
      throw new Error("unexpected");
    });
    expect(calls).toBe(1);
  });
  it("resolves an exact name and binds subsequent snapshots to native file ID", async () => {
    const requests: string[] = [];
    const value = client(async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith("b2_list_file_names")) return Response.json({ files: [file], nextFileName: null });
      if (url.pathname.endsWith("b2_get_file_info")) {
        expect(JSON.parse(String(init?.body)).fileId).toBe(file.fileId);
        return Response.json(file);
      }
      expect(url.searchParams.get("fileId")).toBe(file.fileId);
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-2");
      return media("bc", 206, { "content-range": "bytes 1-2/3" });
    });
    const source = await openObjectSource(createB2DriverFromClient(value), file.fileName);
    expect(await source.read(1, 2)).toEqual(new TextEncoder().encode("bc"));
    expect(requests.filter((path) => path.endsWith("b2_list_file_names"))).toHaveLength(1);
  });
  it("does not mistake a prefix neighbor for an existing exact name", async () => {
    expect(
      await client(async () => Response.json({ files: [{ ...file, fileName: `${file.fileName}extra` }] })).head(
        file.fileName,
      ),
    ).toBeNull();
  });
  it("rejects wrong-name file IDs and unsupported conditions before media IO", async () => {
    let calls = 0;
    const value = client(async () => {
      calls++;
      return Response.json({ ...file, fileName: "other" });
    });
    await expect(value.get(file.fileName, { revision: { kind: "version", value: file.fileId } })).rejects.toThrow(
      "another file name",
    );
    expect(calls).toBe(1);
    await expect(value.put(file.fileName, new Uint8Array(), { ifNoneMatch: "*" })).rejects.toThrow("conditions");
    await expect(value.delete(file.fileName, { revision: { kind: "version", value: file.fileId } })).rejects.toThrow(
      "condition",
    );
    expect(calls).toBe(1);
  });
  it("checks exact media range, immutable identity, encoding and terminal byte count", async () => {
    for (
      const response of [
        media("bc", 200),
        media("bc", 206, { "content-range": "bytes 0-1/3" }),
        media("bc", 206, { "content-range": "bytes 1-2/3", "x-bz-file-id": "wrong" }),
        media("bc", 206, { "content-range": "bytes 1-2/3", "content-encoding": "gzip" }),
      ]
    ) {
      await expect(client(async () => response).download(file, { at: 1, length: 2 })).rejects.toThrow();
      expect(response.bodyUsed).toBe(true);
    }
    const stream = await client(async () => media("a", 200, { "content-length": "3" })).download(file);
    await expect(new Response(stream).text()).rejects.toThrow("truncated");
  });
  it("uses the upload-scoped token, native SHA1, encoded names and an attributable receipt", async () => {
    let calls = 0;
    const value = client(async (input, init) => {
      calls++;
      if (String(input).includes("b2_get_upload_url")) {
        return Response.json({
          bucketId: "bucket",
          uploadUrl: "https://upload.example.test/file?opaque=1",
          authorizationToken: "upload-secret",
        });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("upload-secret");
      expect(headers.get("x-bz-content-sha1")).toBe(abcSha1);
      expect(headers.get("x-bz-file-name")).toBe(encodeURIComponent(file.fileName));
      expect(headers.get("content-length")).toBe("3");
      expect(await new Response(init?.body).text()).toBe("abc");
      return Response.json(file);
    });
    expect(await value.put(file.fileName, new TextEncoder().encode("abc"))).toMatchObject({
      revision: { kind: "version", value: file.fileId },
    });
    expect(calls).toBe(2);
  });
  it("uploads directory-marker metadata and decodes native plus-encoded filenames", async () => {
    let writes = 0;
    const value = client(async (input, init) => {
      if (String(input).includes("b2_list_file_names")) return Response.json({ files: [], nextFileName: null });
      if (String(input).includes("b2_get_upload_url")) {
        return Response.json({
          bucketId: "bucket",
          uploadUrl: "https://upload.example.test/file",
          authorizationToken: "upload-secret",
        });
      }
      writes++;
      expect(new Headers(init?.headers).get("x-bz-info-okikio_opfs_kind")).toBe("directory");
      return Response.json({
        ...file,
        fileName: "folder/",
        contentLength: 0,
        contentSha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
        fileInfo: { okikio_opfs_kind: "directory" },
      });
    });
    await createB2Adapter(value).createDir("/folder");
    expect(writes).toBe(1);
    const spaced = { ...file, fileName: "a b" };
    expect(
      await new Response(await client(async () => media("abc", 200, { "x-bz-file-name": "a+b" })).download(spaced))
        .text(),
    ).toBe("abc");
  });
  it("applies native byte extents even when caller length accessors lie", async () => {
    let calls = 0;
    const value = client(async () => {
      calls++;
      throw new Error("unexpected");
    }, 2);
    const bytes = new Uint8Array(3);
    Object.defineProperty(bytes, "byteLength", {
      get() {
        throw new Error("spoof getter");
      },
    });
    await expect(value.put(file.fileName, bytes)).rejects.toThrow("policy");
    expect(calls).toBe(0);
    await expect(value.put("bad\ud800", new Uint8Array())).rejects.toThrow("name");
    await expect(value.put(file.fileName, new Uint8Array(), { metadata: { label: "x".repeat(2049) } })).rejects.toThrow(
      "budget",
    );
    await expect(value.put(file.fileName, new ReadableStream())).rejects.toThrow("materialized");
    expect(calls).toBe(0);
  });
  it("never blindly retries an unknown upload outcome or a malformed receipt", async () => {
    for (const failure of [true, false]) {
      let writes = 0;
      const value = client(async (input) => {
        if (String(input).includes("b2_get_upload_url")) {
          return Response.json({
            bucketId: "bucket",
            uploadUrl: "https://upload.example.test/file",
            authorizationToken: "upload-secret",
          });
        }
        writes++;
        if (failure) throw new Error("lost response");
        return Response.json({ ...file, contentSha1: "wrong" });
      });
      await expect(value.put(file.fileName, new TextEncoder().encode("abc"))).rejects.toBeInstanceOf(
        B2PublicationError,
      );
      expect(writes).toBe(1);
    }
  });
  it("treats dispatched timeout and server failures as unknown publication without retry", async () => {
    for (const status of [408, 500, 503, 202]) {
      let writes = 0;
      const value = client(async (input) => {
        if (String(input).includes("b2_get_upload_url")) {
          return Response.json({
            bucketId: "bucket",
            uploadUrl: "https://upload.example.test/file",
            authorizationToken: "upload-secret",
          });
        }
        writes++;
        return Response.json(status === 202 ? file : { code: "service_unavailable" }, { status });
      });
      await expect(value.put(file.fileName, new TextEncoder().encode("abc"))).rejects.toBeInstanceOf(
        B2PublicationError,
      );
      expect(writes).toBe(1);
    }
    const denied = client(async (input) =>
      String(input).includes("b2_get_upload_url")
        ? Response.json({
          bucketId: "bucket",
          uploadUrl: "https://upload.example.test/file",
          authorizationToken: "upload-secret",
        })
        : Response.json({ code: "unauthorized" }, { status: 401 })
    );
    await expect(denied.put(file.fileName, new TextEncoder().encode("abc"))).rejects.toMatchObject({
      name: "B2Error",
      status: 401,
    });
  });
  it("separates upload implementation and user limits without capping existing-object reads", () => {
    const value = client(async () => {
      throw new Error("plan must not fetch");
    }, 1024);
    const driver = createB2DriverFromClient(value);
    expect(driver.inspect().limits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "upload-bytes",
        kind: "hard",
        source: "implementation",
        value: 64 * 1024 * 1024,
      }),
      expect.objectContaining({ code: "upload-bytes", kind: "policy", source: "user", value: 1024 }),
    ]));
    expect(driver.plan({ operation: "read", size: 128 * 1024 * 1024 }).supported).toBe(true);
    expect(driver.plan({ operation: "write", size: 1025 }).supported).toBe(false);
    expect(driver.plan({ operation: "write", size: 1024 }).supported).toBe(true);
    expect(driver.portableLimits?.maxFileBytes).toBeUndefined();
  });
  it("hides a name for filesystem removal and keeps exact version deletion separate", async () => {
    const operations: string[] = [];
    const value = client(async (input, init) => {
      const operation = new URL(String(input)).pathname.split("/").at(-1)!;
      operations.push(operation);
      const body = JSON.parse(String(init?.body));
      if (operation === "b2_hide_file") {
        return Response.json({ action: "hide", bucketId: "bucket", fileName: body.fileName, fileId: "hidden" });
      }
      return Response.json({ fileName: body.fileName, fileId: body.fileId });
    });
    await value.delete(file.fileName);
    await value.deleteVersion(file);
    expect(operations).toEqual(["b2_hide_file", "b2_delete_file_version"]);
    expect(createB2Adapter(value).capabilities.streamWriteModes).toEqual([]);
    expect(createB2DriverFromClient(value).capabilities.conditionalWrite).toBe(false);
  });
  it("retains opaque cursors and distinguishes folder entries", async () => {
    const value = client(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.startFileName).toBe("dir/é?#");
      return Response.json({ files: [file, { action: "folder", fileName: "dir/folder/" }], nextFileName: "dir/z?#" });
    });
    expect(await value.list({ prefix: "dir/", delimiter: "/", cursor: "dir/é?#" })).toMatchObject({
      prefixes: ["dir/folder/"],
      cursor: "dir/z?#",
      objects: [{ key: file.fileName }],
    });
  });
  it("cancels rejected response bodies and honors abort before upload URL acquisition", async () => {
    let cancelled = 0;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-length": "3" } },
    );
    await expect(client(async () => response).download(file)).rejects.toThrow();
    expect(cancelled).toBe(1);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      client(async () => {
        calls++;
        throw new Error();
      }).put(file.fileName, new Uint8Array(), { signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
