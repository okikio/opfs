import { describe, it } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { expect } from "@std/expect";
import {
  createGlacierClient,
  GLACIER_MIB,
  glacierMultipartHash,
  GlacierPublicationError,
  glacierTreeHash,
} from "../src/glacier.ts";
import type { GlacierJobType, GlacierOptionsType } from "../src/glacier.ts";
import { observeBytes, retire } from "../src/stream.ts";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
function options(fetch: GlacierOptionsType["fetch"], extra: Partial<GlacierOptionsType> = {}): GlacierOptionsType {
  return {
    endpoint: "https://glacier.us-east-1.amazonaws.com",
    account: "-",
    vault: "fixture",
    region: "us-east-1",
    credentials,
    fetch,
    subtle: crypto.subtle,
    now: () => new Date("2013-05-24T00:00:00Z"),
    requestPolicy: { retries: 0 },
    ...extra,
  };
}
/** Independently implemented full-level reduction uses Node's SHA, not the candidate spine. */
function referenceTree(bytes: Uint8Array): string {
  let nodes: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += GLACIER_MIB) {
    nodes.push(createHash("sha256").update(bytes.subarray(at, at + GLACIER_MIB)).digest());
  }
  if (nodes.length === 0) return createHash("sha256").digest("hex");
  while (nodes.length > 1) {
    const next: Uint8Array[] = [];
    for (let at = 0; at < nodes.length; at += 2) {
      next.push(
        at + 1 === nodes.length ? nodes[at]! : createHash("sha256").update(nodes[at]!).update(nodes[at + 1]!).digest(),
      );
    }
    nodes = next;
  }
  return [...nodes[0]!].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function job(extra: Partial<GlacierJobType> = {}): GlacierJobType {
  return {
    JobId: "job",
    Action: "ArchiveRetrieval",
    Completed: true,
    StatusCode: "Succeeded",
    ArchiveId: "archive",
    ArchiveSizeInBytes: 8,
    RetrievalByteRange: "0-7",
    ...extra,
  };
}
function receipt(id: string, kind = "archive"): Headers {
  return new Headers({
    [`x-amz-${kind}-id`]: id,
    location: `/-/vaults/fixture/${
      kind === "job" ? "jobs" : kind === "multipart-upload" ? "multipart-uploads" : "archives"
    }/${id}`,
    "x-amzn-requestid": "request",
  });
}

describe("Glacier tree and multipart admission", () => {
  it("matches independent full trees at empty, leaf, odd, and partial boundaries", async () => {
    for (
      const size of [
        0,
        1,
        GLACIER_MIB - 1,
        GLACIER_MIB,
        GLACIER_MIB + 1,
        3 * GLACIER_MIB,
        5 * GLACIER_MIB + 17,
        7 * GLACIER_MIB,
      ]
    ) {
      const bytes = Uint8Array.from({ length: size }, (_, at) => (at * 31 + (at >>> 20)) & 255);
      expect(await glacierTreeHash(bytes, crypto.subtle)).toBe(referenceTree(bytes));
    }
  });
  it("reduces fixed-size part roots including a short odd final subtree", async () => {
    const bytes = Uint8Array.from({ length: 11 * GLACIER_MIB + 13 }, (_, at) => at % 251);
    const size = 4 * GLACIER_MIB;
    const parts = [];
    for (let start = 0; start < bytes.length; start += size) {
      const end = Math.min(bytes.length, start + size) - 1;
      parts.push({ start, end, treeHash: referenceTree(bytes.subarray(start, end + 1)) });
    }
    expect(await glacierMultipartHash({ id: "upload", partSize: size }, parts, bytes.length, crypto.subtle)).toBe(
      referenceTree(bytes),
    );
    await expect(
      glacierMultipartHash({ id: "upload", partSize: size }, [...parts].reverse(), bytes.length, crypto.subtle),
    ).rejects.toThrow();
    await expect(glacierMultipartHash({ id: "upload", partSize: size }, parts.slice(1), bytes.length, crypto.subtle))
      .rejects.toThrow();
  });
  it("rejects invalid ranges, descriptions, part layouts, and page limits before foreign callbacks", async () => {
    let calls = 0;
    const client = createGlacierClient(options(async () => {
      calls++;
      throw new Error("unexpected transport");
    }, {
      credentials: () => {
        calls++;
        return credentials;
      },
    }));
    await expect(client.startArchiveJob("archive", { start: 0, end: 2, archiveSize: 8 })).rejects.toThrow();
    await expect(client.startArchiveJob("archive", { start: 0, end: 7 })).rejects.toThrow();
    await expect(client.createUpload(3 * GLACIER_MIB)).rejects.toThrow();
    await expect(client.uploadArchive(new Uint8Array(), { description: "bad\n" })).rejects.toThrow();
    await expect(client.uploadPart({ id: "upload", partSize: GLACIER_MIB }, 1, new Uint8Array([1]))).rejects.toThrow();
    await expect(client.listJobsPage({ limit: 51 })).rejects.toThrow();
    await expect(client.listJobsPage({ marker: "bad\nmarker" })).rejects.toThrow();
    await expect(client.listUploadsPage({ marker: "bad\ud800" })).rejects.toThrow();
    await expect(client.describeJob("..")).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe("Glacier signing and native mutations", () => {
  it("signs exact Glacier scope and headers against independent Node HMAC", async () => {
    let captured: Request | undefined;
    const client = createGlacierClient(options(async (input, init) => {
      captured = new Request(input, init);
      return Response.json({ JobList: [], Marker: null });
    }, { credentials: { ...credentials, sessionToken: "temporary" } }));
    await client.listJobsPage({ marker: "a/b+%", limit: 2 });
    const request = captured!;
    expect(request.url).toBe(
      "https://glacier.us-east-1.amazonaws.com/-/vaults/fixture/jobs?limit=2&marker=a%2Fb%2B%25",
    );
    const auth = request.headers.get("authorization")!;
    const names = ["host", "x-amz-content-sha256", "x-amz-date", "x-amz-glacier-version", "x-amz-security-token"];
    const headers =
      names.map((name) => `${name}:${name === "host" ? new URL(request.url).host : request.headers.get(name)}`).join(
        "\n",
      ) + "\n";
    const url = new URL(request.url);
    const canonical = [
      "GET",
      url.pathname,
      url.search.slice(1),
      headers,
      names.join(";"),
      createHash("sha256").digest("hex"),
    ].join("\n");
    const scope = "20130524/us-east-1/glacier/aws4_request";
    let key = createHmac("sha256", `AWS4${credentials.secretAccessKey}`).update("20130524").digest();
    for (const value of ["us-east-1", "glacier", "aws4_request"]) {
      key = createHmac("sha256", key).update(value).digest();
    }
    const signature = createHmac("sha256", key).update(
      `AWS4-HMAC-SHA256\n20130524T000000Z\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`,
    ).digest("hex");
    expect(auth).toBe(
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${
        names.join(";")
      }, Signature=${signature}`,
    );
    expect(request.headers.has("host")).toBe(false);
    expect(request.redirect).toBe("manual");
  });
  it("never replays lost job or archive publication and retains unknown outcomes", async () => {
    let calls = 0;
    const client = createGlacierClient(options(async () => {
      calls++;
      throw undefined;
    }, { requestPolicy: { retries: 3, minDelayMs: 0, maxDelayMs: 0 } }));
    for (const action of [() => client.startArchiveJob("archive"), () => client.uploadArchive(new Uint8Array([1]))]) {
      try {
        await action();
        throw new Error("Expected unknown publication.");
      } catch (error) {
        expect(error).toBeInstanceOf(GlacierPublicationError);
        expect((error as GlacierPublicationError).outcome).toBe("unknown");
      }
    }
    expect(calls).toBe(2);
  });
  it("preserves a publication receipt when unused body retirement fails", async () => {
    const cause = new Error("cancel failed");
    const client = createGlacierClient(options(async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw cause;
          },
        }),
        { status: 202, headers: receipt("job", "job") },
      )
    ));
    try {
      await client.startArchiveJob("archive");
      throw new Error("Expected cleanup failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(GlacierPublicationError);
      expect((error as GlacierPublicationError).outcome).toBe("confirmed");
      expect((error as GlacierPublicationError).receipt?.id).toBe("job");
    }
  });
  it("publishes copied parts and exact completion roots without whole-archive buffers", async () => {
    const image = Uint8Array.from([1, 2, 3]);
    const treeHash = referenceTree(image);
    const requests: Request[] = [];
    const client = createGlacierClient(options(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "PUT") {
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([1, 2, 3]);
        return new Response(null, { status: 204, headers: { "x-amz-sha256-tree-hash": treeHash } });
      }
      return new Response(null, { status: 201, headers: receipt("archive") });
    }));
    const upload = { id: "upload", partSize: GLACIER_MIB };
    const pending = client.uploadPart(upload, 0, image);
    image.fill(9);
    const part = await pending;
    expect(part).toEqual({ start: 0, end: 2, treeHash });
    expect((await client.completeUpload(upload, [part], 3)).id).toBe("archive");
    expect(requests[0]!.headers.get("content-range")).toBe("bytes 0-2/*");
    expect(requests[1]!.headers.get("x-amz-archive-size")).toBe("3");
    expect(requests[1]!.headers.get("x-amz-sha256-tree-hash")).toBe(treeHash);
  });
  it("accepts its own initiation receipt in subsequent multipart operations", async () => {
    const bytes = new Uint8Array([1]);
    const treeHash = referenceTree(bytes);
    const client = createGlacierClient(options(async (_input, init) => {
      if (init?.method === "POST") {
        return new Response(null, { status: 201, headers: receipt("upload", "multipart-upload") });
      }
      return new Response(null, { status: 204, headers: { "x-amz-sha256-tree-hash": treeHash } });
    }));
    const upload = await client.createUpload(GLACIER_MIB);
    expect(upload.location).toBe("/-/vaults/fixture/multipart-uploads/upload");
    expect((await client.uploadPart(upload, 0, bytes)).treeHash).toBe(treeHash);
    await client.abortUpload(upload);
  });
  it("retains nullable page termination and detects marker cycles during reconciliation", async () => {
    let calls = 0;
    const client = createGlacierClient(options(async () => {
      calls++;
      return Response.json({ MultipartUploadId: "upload", PartSizeInBytes: GLACIER_MIB, Parts: [], Marker: "repeat" });
    }));
    await expect(client.listParts({ id: "upload", partSize: GLACIER_MIB }, { maxPages: 3 })).rejects.toThrow("marker");
    expect(calls).toBe(2);
  });
});

describe("Glacier completed output", () => {
  it("uses job-relative coordinates and verifies selected bytes before returning", async () => {
    const bytes = Uint8Array.from([3, 4]);
    let requested: string | null = null;
    const client = createGlacierClient(options(async (_input, init) => {
      requested = new Headers(init?.headers).get("range");
      return new Response(bytes, { status: 206, headers: { "content-range": "bytes 2-3/8", "content-length": "2" } });
    }));
    const output = await client.readOutput(
      job({ ArchiveSizeInBytes: GLACIER_MIB + 8, RetrievalByteRange: `${GLACIER_MIB}-${GLACIER_MIB + 7}` }),
      2,
      2,
      { requireChecksum: true, expectedTreeHash: referenceTree(bytes) },
    );
    expect(requested).toBe("bytes=2-3");
    expect([...output.bytes]).toEqual([3, 4]);
    expect(output.checksum).toBe("caller");
  });
  it("rejects pending output, ignored ranges, truncation, encoding, and malformed or absent checksum evidence", async () => {
    let calls = 0;
    const client = createGlacierClient(options(async () => {
      calls++;
      return new Response(new Uint8Array([1]), { status: 200 });
    }));
    await expect(client.readOutput(job({ Completed: false, StatusCode: "InProgress" }), 0, 1)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(client.readOutput(job(), 1, 1)).rejects.toThrow();
    for (const headers of [{}, { "content-encoding": "gzip" }, { "x-amz-sha256-tree-hash": "g".repeat(64) }]) {
      const bad = createGlacierClient(options(async () => new Response(new Uint8Array([1]), { headers })));
      await expect(bad.readOutput(job(), 0, 8, { requireChecksum: true })).rejects.toThrow();
    }
    const short = createGlacierClient(options(async () => new Response(new Uint8Array([1]))));
    await expect(short.readOutput(job(), 0, 8)).rejects.toThrow("truncated");
    const mismatch = createGlacierClient(
      options(async () => new Response(new Uint8Array(8), { headers: { "x-amz-sha256-tree-hash": "a".repeat(64) } })),
    );
    await expect(mismatch.readOutput(job(), 0, 8)).rejects.toThrow("checksum mismatch");
  });
  it("borrows completed output and keeps empty reads local while preserving original archive offset", async () => {
    let calls = 0;
    const client = createGlacierClient(options(async () => {
      calls++;
      return Response.json(
        job({ ArchiveSizeInBytes: GLACIER_MIB + 8, RetrievalByteRange: `${GLACIER_MIB}-${GLACIER_MIB + 7}` }),
      );
    }));
    const source = await client.openOutput("job");
    expect(source.size).toBe(8);
    expect(source.archiveOffset).toBe(GLACIER_MIB);
    expect((await source.read(8, 0)).length).toBe(0);
    expect(calls).toBe(1);
    await expect(source.read(8, 1)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

it("waits for output refusal cleanup and retains its independent failure", async () => {
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cleanup = new Error("response cancellation failed");
  const client = createGlacierClient(options(async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          began.resolve();
          return release.promise.then(() => {
            throw cleanup;
          });
        },
      }),
    )
  ));
  let finished = false;
  const pending = client.readOutput(job(), 1, 1).then(() => {
    finished = true;
    return undefined;
  }, (reason: unknown) => {
    finished = true;
    return reason;
  });
  await began.promise;
  expect(finished).toBe(false);
  release.resolve();
  const failure = await pending;
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toContain(cleanup);
});

it("retains lost completion as unknown and never infers publication from a missing upload", async () => {
  let calls = 0;
  const client = createGlacierClient(options(async () => {
    calls++;
    throw new Error("lost completion receipt");
  }, { requestPolicy: { retries: 3, minDelayMs: 0, maxDelayMs: 0 } }));
  const parts = [{ start: 0, end: 0, treeHash: referenceTree(new Uint8Array([1])) }];
  try {
    await client.completeUpload({ id: "upload", partSize: GLACIER_MIB }, parts, 1);
    throw new Error("Expected unknown completion.");
  } catch (error) {
    expect(error).toBeInstanceOf(GlacierPublicationError);
    expect((error as GlacierPublicationError).outcome).toBe("unknown");
  }
  expect(calls).toBe(1);
});

/** Delay only digest delivery while retaining native HMAC/import behavior. No candidate output supplies the expectation. */
function delayedCrypto(entered: () => void, wait: Promise<void>): SubtleCrypto {
  return {
    digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      entered();
      await wait;
      return await crypto.subtle.digest(algorithm, data);
    },
    importKey: crypto.subtle.importKey.bind(crypto.subtle),
    sign: crypto.subtle.sign.bind(crypto.subtle),
  } as SubtleCrypto;
}

it("owns tree-hash bytes before awaiting delayed crypto", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const bytes = new Uint8Array(GLACIER_MIB + 17).fill(7);
  const expected = referenceTree(bytes);
  const pending = glacierTreeHash(bytes, delayedCrypto(() => entered.resolve(), release.promise));
  await entered.promise;
  bytes.fill(9);
  release.resolve();
  expect(await pending).toBe(expected);
});

it("owns multipart bytes across delayed credentials and retry, and snapshots constructor values", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const bytes = Uint8Array.from([1, 2, 3]);
  const treeHash = referenceTree(bytes);
  const seen: number[][] = [];
  let calls = 0;
  const policy = { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
  const supplied = { ...credentials };
  const client = createGlacierClient(options(async (input, init) => {
    const request = new Request(input, init);
    seen.push([...new Uint8Array(await request.arrayBuffer())]);
    expect(request.headers.get("x-amz-content-sha256")).toBe(
      createHash("sha256").update(Uint8Array.from([1, 2, 3])).digest("hex"),
    );
    if (++calls === 1) {
      bytes.fill(8);
      throw new Error("retry part");
    }
    return new Response(null, { status: 204, headers: { "x-amz-sha256-tree-hash": treeHash } });
  }, {
    credentials: async () => {
      entered.resolve();
      await release.promise;
      return supplied;
    },
    requestPolicy: policy,
  }));
  policy.retries = 0;
  const pending = client.uploadPart({ id: "upload", partSize: GLACIER_MIB }, 0, bytes);
  await entered.promise;
  bytes.fill(9);
  release.resolve();
  expect((await pending).treeHash).toBe(treeHash);
  expect(seen).toEqual([[1, 2, 3], [1, 2, 3]]);
  let authorization = "";
  const staticCredentials = { ...credentials };
  const staticClient = createGlacierClient(options(async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization")!;
    return Response.json({ JobList: [], Marker: null });
  }, { credentials: staticCredentials }));
  staticCredentials.accessKeyId = "replaced";
  await staticClient.listJobsPage();
  expect(authorization).toContain("Credential=AKIDEXAMPLE/");
});

it("captures upload cancellation before delayed hashing and read checksum policy before delayed Fetch", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const replacement = new AbortController();
  const settings = { signal: controller.signal };
  let fetches = 0;
  const client = createGlacierClient(options(async () => {
    fetches++;
    return new Response(null);
  }, { subtle: delayedCrypto(() => entered.resolve(), release.promise) }));
  const pending = client.uploadArchive(new Uint8Array([1]), settings);
  const observed = pending.catch((reason: unknown) => reason);
  await entered.promise;
  settings.signal = replacement.signal;
  controller.abort("original cancellation");
  release.resolve();
  expect(await observed).toBe("original cancellation");
  expect(fetches).toBe(0);

  const fetched = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const readSettings = { requireChecksum: true };
  const reader = createGlacierClient(options(async () => {
    fetched.resolve();
    return await response.promise;
  }));
  const reading = reader.readOutput(job(), 0, 8, readSettings);
  const rejected = reading.catch((reason: unknown) => reason);
  await fetched.promise;
  readSettings.requireChecksum = false;
  response.resolve(new Response(new Uint8Array(8)));
  expect(await rejected).toBeInstanceOf(TypeError);
});

it("preflights checksum eligibility and malformed completed ranges before crypto or credentials", async () => {
  let callbacks = 0;
  const entered = () => {
    callbacks++;
  };
  const client = createGlacierClient(options(async () => {
    callbacks++;
    throw new Error("unexpected Fetch");
  }, {
    subtle: delayedCrypto(entered, Promise.resolve()),
    credentials: () => {
      callbacks++;
      return credentials;
    },
  }));
  const archiveSize = 6 * GLACIER_MIB + 13;
  const whole = job({ ArchiveSizeInBytes: archiveSize, RetrievalByteRange: `0-${archiveSize - 1}` });
  const nonnode = job({
    ArchiveSizeInBytes: archiveSize,
    RetrievalByteRange: `${2 * GLACIER_MIB}-${5 * GLACIER_MIB - 1}`,
  });
  await expect(client.readOutput(whole, GLACIER_MIB, 2 * GLACIER_MIB, { requireChecksum: true })).rejects.toThrow(
    "eligible",
  );
  await expect(client.readOutput(nonnode, 0, GLACIER_MIB, { requireChecksum: true })).rejects.toThrow("eligible");
  await expect(
    client.readOutput(job({ Action: "InventoryRetrieval", InventorySizeInBytes: 8 }), 0, 8, { requireChecksum: true }),
  ).rejects.toThrow("eligible");
  for (const range of ["1-7", "0-6", `0-${archiveSize}`]) {
    await expect(client.readOutput(job({ ArchiveSizeInBytes: archiveSize, RetrievalByteRange: range }), 0, 1)).rejects
      .toThrow();
  }
  await expect(client.uploadPart({ id: "\ud800", partSize: GLACIER_MIB }, 0, new Uint8Array([1]))).rejects.toThrow();
  expect(callbacks).toBe(0);
});

it("admits original-coordinate tree nodes including odd promoted tail nodes", async () => {
  const archiveSize = 6 * GLACIER_MIB + 13;
  const selectedStart = 4 * GLACIER_MIB;
  const selectedSize = archiveSize - selectedStart;
  const selected = job({ ArchiveSizeInBytes: archiveSize, RetrievalByteRange: `${selectedStart}-${archiveSize - 1}` });
  for (const [offset, length] of [[0, selectedSize], [0, 2 * GLACIER_MIB], [2 * GLACIER_MIB, 13]]) {
    const bytes = new Uint8Array(length!);
    const client = createGlacierClient(
      options(async () =>
        new Response(bytes, {
          status: length === selectedSize ? 200 : 206,
          headers: {
            "x-amz-sha256-tree-hash": referenceTree(bytes),
            ...(length === selectedSize
              ? {}
              : { "content-range": `bytes ${offset}-${offset! + length! - 1}/${selectedSize}` }),
          },
        })
      ),
    );
    expect((await client.readOutput(selected, offset!, length!, { requireChecksum: true })).checksum).toBe("service");
  }
});

it("refuses unexpected service-checksum scope and foreign receipt prefixes or userinfo", async () => {
  const bytes = new Uint8Array([1]);
  const client = createGlacierClient(
    options(async () =>
      new Response(bytes, {
        status: 206,
        headers: { "content-range": "bytes 1-1/8", "x-amz-sha256-tree-hash": referenceTree(bytes) },
      })
    ),
  );
  await expect(client.readOutput(job(), 1, 1, { expectedTreeHash: referenceTree(bytes) })).rejects.toThrow(
    "not applicable",
  );
  for (
    const location of [
      "/other/-/vaults/fixture/jobs/job",
      "https://name:password@glacier.us-east-1.amazonaws.com/gateway/-/vaults/fixture/jobs/job",
    ]
  ) {
    const headers = receipt("job", "job");
    headers.set("location", location);
    const bad = createGlacierClient(
      options(async () => new Response(null, { status: 202, headers }), {
        endpoint: "https://glacier.us-east-1.amazonaws.com/gateway",
      }),
    );
    try {
      await bad.startArchiveJob("archive");
      throw new Error("Expected receipt refusal.");
    } catch (error) {
      expect(error).toBeInstanceOf(GlacierPublicationError);
      expect((error as GlacierPublicationError).outcome).toBe("unknown");
    }
  }
});

it("keeps escaped Glacier wire paths distinct from double-escaped general AWS signing paths", async () => {
  const id = "A/B+C=%雪";
  let request: Request | undefined;
  const client = createGlacierClient(options(async (input, init) => {
    request = new Request(input, init);
    return Response.json(job({ JobId: id }));
  }, { endpoint: "https://glacier.us-east-1.amazonaws.com:8443/fixture%20prefix/%25root" }));
  await client.describeJob(id);
  const captured = request!;
  expect(new URL(captured.url).pathname).toBe(
    "/fixture%20prefix/%25root/-/vaults/fixture/jobs/A%2FB%2BC%3D%25%E9%9B%AA",
  );
  // This preimage is fixed from the independent pinned Smithy source policy,
  // not calculated using Glacier's private canonicalPath implementation.
  const path = "/fixture%2520prefix/%2525root/-/vaults/fixture/jobs/A%252FB%252BC%253D%2525%25E9%259B%25AA";
  const names = ["host", "x-amz-content-sha256", "x-amz-date", "x-amz-glacier-version"];
  const headers =
    names.map((name) =>
      `${name}:${name === "host" ? "glacier.us-east-1.amazonaws.com:8443" : captured.headers.get(name)}`
    ).join("\n") + "\n";
  const canonical = ["GET", path, "", headers, names.join(";"), createHash("sha256").digest("hex")].join("\n");
  const scope = "20130524/us-east-1/glacier/aws4_request";
  let key = createHmac("sha256", `AWS4${credentials.secretAccessKey}`).update("20130524").digest();
  for (const value of ["us-east-1", "glacier", "aws4_request"]) key = createHmac("sha256", key).update(value).digest();
  const signature = createHmac("sha256", key).update(
    `AWS4-HMAC-SHA256\n20130524T000000Z\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`,
  ).digest("hex");
  expect(captured.headers.get("authorization")).toBe(
    `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  );
});

it("retains borrowed read and release failures without recancelling a delivered rejection", async () => {
  const release = new Error("borrowed release failed");
  const body = new ReadableStream<Uint8Array>();
  Object.defineProperty(body, "getReader", {
    value: () => ({
      read: () => Promise.reject(undefined),
      cancel: () => Promise.reject(null),
      releaseLock: () => {
        throw release;
      },
    }),
  });
  const client = createGlacierClient(options(async () => new Response(body)));
  const failure = await client.readOutput(job(), 0, 8).catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([undefined, release]);
});

it("preserves simultaneous source rejection and caller abort as distinct observations", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(source) {
      queueMicrotask(() => {
        source.error(undefined);
        controller.abort(null);
      });
    },
  }, { highWaterMark: 0 });
  const client = createGlacierClient(options(async () => new Response(body)));
  const failure = await client.readOutput(job(), 0, 8, { signal: controller.signal }).catch((reason: unknown) =>
    reason
  );
  const reasons = (value: unknown): unknown[] =>
    value instanceof AggregateError ? value.errors.flatMap(reasons) : [value];
  expect(reasons(failure)).toContain(undefined);
  expect(reasons(failure)).toContain(null);
});

it("marks exact first-party source rejection delivered before later retirement", async () => {
  const source = observeBytes(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(undefined);
      },
    }, { highWaterMark: 0 }),
    () => {},
    "/archive",
    "read",
  );
  const client = createGlacierClient(options(async () => new Response(source)));
  let failed = false;
  await client.readOutput(job(), 0, 8).catch(() => {
    failed = true;
  });
  expect(failed).toBe(true);
  await retire(source);
});

it("retains independently observed cancellation and release faults after a body-size refusal", async () => {
  const release = new Error("borrowed release failed");
  const body = new ReadableStream<Uint8Array>();
  Object.defineProperty(body, "getReader", {
    value: () => ({
      read: async () => ({ done: false, value: new Uint8Array(9) }),
      cancel: () => Promise.reject(null),
      releaseLock: () => {
        throw release;
      },
    }),
  });
  const client = createGlacierClient(options(async () => new Response(body)));
  const failure = await client.readOutput(job(), 0, 8).catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors;
  expect(errors[0]).toBeInstanceOf(RangeError);
  expect(errors.slice(1)).toEqual([null, release]);
});

import "./glacier-oracle.ts";

it("retires its acquired output reader when the caller-raised allocation ceiling cannot be materialized", async () => {
  let cancellations = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
      },
    }),
  );
  const client = createGlacierClient(options(async () => response, { maxBodyBytes: Number.MAX_SAFE_INTEGER }));
  await expect(
    client.readOutput(
      job({ ArchiveSizeInBytes: Number.MAX_SAFE_INTEGER, RetrievalByteRange: null }),
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  ).rejects.toBeInstanceOf(RangeError);
  expect(cancellations).toBe(1);
  expect(response.body!.locked).toBe(false);
});
