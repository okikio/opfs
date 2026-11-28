/** Azure: Authorization uses exact canonical bytes and request-local credentials. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createAzureClient } from "../../src/backend/azure/client.ts";
import { RequestCapture } from "../http.ts";

/** Refreshable bearer source used to prove per-request token resolution. */
class BearerTokenSource {
  /** Number of token requests observed. */
  calls = 0;

  /** Returns one token value that identifies its refresh call. */
  get(): string {
    this.calls += 1;
    return `token-${this.calls}`;
  }
}

describe("Azure Blob client", () => {
  it("creates the documented Azurite Shared Key canonical signature", async () => {
    let request: Request | undefined;
    const client = createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential: {
        kind: "shared-key",
        account: "devstoreaccount1",
        key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
      },
      now: () => new Date("2026-08-14T12:00:00.000Z"),
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 201 });
      },
    });

    await client.request({ method: "PUT", query: { restype: "container" } });

    expect(request?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:h5gDRN/kZdrsO5FfUgKPNZGwb9UgFzqZvIDC5iVFi94=",
    );
    expect(request?.headers.get("x-ms-date")).toBe("Fri, 14 Aug 2026 12:00:00 GMT");
    expect(request?.headers.get("content-length")).toBe("0");
  });

  it("rejects Shared Key service versions older than the implemented signing format", () => {
    expect(() =>
      createAzureClient({
        endpoint: "http://127.0.0.1:10000/devstoreaccount1",
        container: "opfs-test",
        credential: {
          kind: "shared-key",
          account: "devstoreaccount1",
          key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
        },
        version: "2009-07-17",
      })
    ).toThrow(RangeError);
  });

  it("signs zero Content-Length according to the selected Shared Key service version", async () => {
    const oldCapture = new RequestCapture();
    const modernCapture = new RequestCapture();
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const options = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    await createAzureClient({ ...options, version: "2014-02-14", fetch: oldCapture.fetch.bind(oldCapture) }).request({
      method: "PUT",
      key: "zero.bin",
      body: new Uint8Array(),
    });
    await createAzureClient({ ...options, version: "2015-02-21", fetch: modernCapture.fetch.bind(modernCapture) })
      .request({
        method: "PUT",
        key: "zero.bin",
        body: new Uint8Array(),
      });

    expect(oldCapture.latest?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:l0m1mkwouin+1Fe6pBOf3LgSCgsrZMzD4luPiqfRonQ=",
    );
    expect(modernCapture.latest?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:JHL00B0fQHliBPS7Gz7O2DcsyB3DwEnHjFUUxfTKvIY=",
    );
  });

  it("omits empty x-ms headers before 2016-05-31 and signs them from that version onward", async () => {
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const base = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    const legacyEmpty = new RequestCapture();
    const legacyAbsent = new RequestCapture();
    await createAzureClient({ ...base, version: "2015-02-21", fetch: legacyEmpty.fetch.bind(legacyEmpty) }).request({
      method: "HEAD",
      key: "value",
      headers: { "x-ms-meta-empty": "" },
    });
    await createAzureClient({ ...base, version: "2015-02-21", fetch: legacyAbsent.fetch.bind(legacyAbsent) }).request({
      method: "HEAD",
      key: "value",
    });

    const modernEmpty = new RequestCapture();
    const modernAbsent = new RequestCapture();
    await createAzureClient({ ...base, version: "2016-05-31", fetch: modernEmpty.fetch.bind(modernEmpty) }).request({
      method: "HEAD",
      key: "value",
      headers: { "x-ms-meta-empty": "" },
    });
    await createAzureClient({ ...base, version: "2016-05-31", fetch: modernAbsent.fetch.bind(modernAbsent) }).request({
      method: "HEAD",
      key: "value",
    });

    expect(legacyEmpty.latest?.headers.get("authorization")).toBe(legacyAbsent.latest?.headers.get("authorization"));
    expect(modernEmpty.latest?.headers.get("authorization")).not.toBe(
      modernAbsent.latest?.headers.get("authorization"),
    );
  });

  it("canonicalizes Shared Key query fields independently from insertion order", async () => {
    const first = new RequestCapture();
    const second = new RequestCapture();
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const base = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    await createAzureClient({ ...base, fetch: first.fetch.bind(first) }).request({
      method: "GET",
      query: { restype: "container", comp: "list", prefix: "root/" },
    });
    await createAzureClient({ ...base, fetch: second.fetch.bind(second) }).request({
      method: "GET",
      query: { prefix: "root/", comp: "list", restype: "container" },
    });

    expect(first.latest?.headers.get("authorization")).toBe(second.latest?.headers.get("authorization"));
  });

  it("collapses unquoted Shared Key whitespace without changing quoted-string whitespace", async () => {
    const now = () => new Date("2026-08-14T12:00:00.000Z");
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const compact = new RequestCapture();
    const spaced = new RequestCapture();
    const quoted = new RequestCapture();

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: compact.fetch.bind(compact),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha beta "two spaces"' } });

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: spaced.fetch.bind(spaced),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha   beta "two spaces"' } });

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: quoted.fetch.bind(quoted),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha beta "two  spaces"' } });

    expect(compact.latest?.headers.get("authorization")).toBe(spaced.latest?.headers.get("authorization"));
    expect(compact.latest?.headers.get("authorization")).not.toBe(quoted.latest?.headers.get("authorization"));
  });

  it("uses SAS query authorization without adding an Authorization header", async () => {
    const capture = new RequestCapture();
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sv=2026-04-06&sig=secret" },
      fetch: capture.fetch.bind(capture),
    });

    await client.request({ method: "HEAD", key: "state.bin" });

    expect(capture.latest?.headers.has("authorization")).toBe(false);
    expect(new URL(capture.latest!.url).searchParams.get("sig")).toBe("secret");
  });

  for (const version of [undefined, "2018-03-28"] as const) {
    it(`uses the ${version ?? "default"} client operation version independently from SAS signing fields`, async () => {
      const capture = new RequestCapture();
      const client = createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "data",
        ...(version === undefined ? {} : { version }),
        credential: {
          kind: "sas",
          token: "?sv=2015-04-05&sig=a%2Bb%2Fc%3D&sp=r&api-version=2016-05-31&api-version=2017-07-29",
        },
        fetch: capture.fetch.bind(capture),
      });

      await client.request({
        method: "HEAD",
        key: "state.bin",
        query: { "api-version": "2020-10-02" },
        headers: { "x-ms-version": "2020-10-02" },
      });

      const request = capture.latest!;
      const query = new URL(request.url).searchParams;
      expect(query.getAll("api-version")).toEqual([version ?? "2026-04-06"]);
      expect(request.headers.get("x-ms-version")).toBe(version ?? "2026-04-06");
      expect(query.get("sv")).toBe("2015-04-05");
      expect(query.get("sig")).toBe("a+b/c=");
      expect(query.get("sp")).toBe("r");
      expect(request.headers.has("authorization")).toBe(false);
    });
  }

  it("resolves a bearer token immediately before every request", async () => {
    const token = new BearerTokenSource();
    const capture = new RequestCapture();
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "bearer", token: token.get.bind(token) },
      fetch: capture.fetch.bind(capture),
    });

    await client.request({ method: "HEAD", key: "one" });
    await client.request({ method: "HEAD", key: "two" });

    expect(token.calls).toBe(2);
    expect(capture.requests[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(capture.requests[1]?.headers.get("authorization")).toBe("Bearer token-2");
  });
});
