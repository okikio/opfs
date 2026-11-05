import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AzureCommitError, AzureError, createAzureClient } from "../src/azure.ts";
import { createAzureSession, createAzureUploadDestination } from "../src/transfer/azure.ts";
import { createTransferCheckpoint, resumeTransfer } from "../src/transfer.ts";

// Authored protocol fixture. Azure SDK/Azurite proof belongs to azure-transfer-provider.test.ts.
function fixture() {
  const state = {
    etag: null as string | null,
    metadata: {} as Record<string, string>,
    output: new Uint8Array(),
    staged: new Map<string, Uint8Array>(),
    calls: [] as string[],
    loseStage: false,
    loseCommit: false,
    commitStatus: 201,
    xml: undefined as string | undefined,
  };
  const client = createAzureClient({
    endpoint: "https://account.test",
    container: "files",
    credential: { kind: "headers", get: () => ({}) },
    request: { retries: 0 },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const operation = url.searchParams.get("comp");
      state.calls.push(`${init?.method}:${operation ?? "blob"}`);
      if (init?.method === "HEAD") {
        return state.etag === null ? new Response(null, { status: 404 }) : new Response(null, {
          headers: {
            etag: state.etag,
            "content-length": String(state.output.length),
            ...Object.fromEntries(Object.entries(state.metadata).map(([key, value]) => [`x-ms-meta-${key}`, value])),
          },
        });
      }
      if (init?.method === "GET") {
        return new Response(
          state.xml ??
            `<BlockList><UncommittedBlocks>${
              [...state.staged].map(([name, bytes]) =>
                `<Block><Name>${name}</Name><Size>${bytes.length}</Size></Block>`
              )
                .join("")
            }</UncommittedBlocks></BlockList>`,
        );
      }
      if (operation === "block") {
        state.staged.set(
          url.searchParams.get("blockid")!,
          new Uint8Array(await new Response(init?.body).arrayBuffer()),
        );
        if (state.loseStage) {
          state.loseStage = false;
          throw new Error("lost stage receipt");
        }
        return new Response(null, { status: 201 });
      }
      if (operation === "blocklist") {
        if (state.commitStatus !== 201) return new Response(null, { status: state.commitStatus });
        const text = await new Response(init?.body).text();
        const ids = [...text.matchAll(/<Uncommitted>([^<]+)<\/Uncommitted>/g)].map((match) => match[1]!);
        const pieces = ids.map((id) => state.staged.get(id)!);
        const output = new Uint8Array(pieces.reduce((size, part) => size + part.length, 0));
        let at = 0;
        for (const part of pieces) {
          output.set(part, at);
          at += part.length;
        }
        const headers = new Headers(init?.headers);
        expect(headers.get("if-none-match") ?? headers.get("if-match")).toBe(state.etag ?? "*");
        state.output = output;
        state.etag = '"published"';
        state.staged.clear();
        state.metadata = {};
        headers.forEach((value, key) => {
          if (key.startsWith("x-ms-meta-")) state.metadata[key.slice(10)] = value;
        });
        if (state.loseCommit) {
          state.loseCommit = false;
          throw new Error("lost final receipt");
        }
        return new Response(null, { status: 201, headers: { etag: state.etag } });
      }
      throw new Error("Unexpected request");
    },
  });
  return { client, state };
}
const options = { key: "a", token: "azure_fixture_unique_token_01", size: 5, blockBytes: 2 };
describe("Azure persisted block continuation", () => {
  it("publishes fixed blocks and session metadata through the common transfer coordinator", async () => {
    const { client, state } = fixture();
    const session = await createAzureSession(client, options);
    const destination = createAzureUploadDestination(client, session);
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const source = {
      identity: "immutable-fixture-v1",
      size: 5,
      read: (offset: number, length: number) => Promise.resolve(input.slice(offset, offset + length)),
    };
    const saves: number[] = [];
    const result = await resumeTransfer({
      source,
      destination,
      checkpoint: createTransferCheckpoint(source, destination),
      chunkBytes: 2,
      save: (value) => {
        saves.push(value.offset);
        return Promise.resolve();
      },
    });
    expect(result.state).toBe("completed");
    expect(state.output).toEqual(input);
    expect(state.metadata.opfs_session).toBe(session.token);
    expect(saves).toContain(5);
  });
  it("reconciles a stage acknowledgement lost before checkpoint persistence", async () => {
    const { client, state } = fixture();
    const session = await createAzureSession(client, options);
    const destination = createAzureUploadDestination(client, session);
    state.loseStage = true;
    await expect(destination.write(0, new Uint8Array([1, 2]))).rejects.toThrow();
    expect(await createAzureUploadDestination(client, JSON.parse(JSON.stringify(session))).status()).toEqual({
      offset: 2,
      size: 5,
      complete: false,
    });
  });
  it("attributes a lost final receipt by unique metadata rather than staged size", async () => {
    const { client, state } = fixture();
    const session = await createAzureSession(client, { ...options, size: 2 });
    const destination = createAzureUploadDestination(client, session);
    await destination.write(0, new Uint8Array([1, 2]));
    expect(await destination.status()).toEqual({ offset: 2, size: 2, complete: false });
    state.loseCommit = true;
    await expect(destination.finish!()).rejects.toBeInstanceOf(AzureCommitError);
    expect(await createAzureUploadDestination(client, session).status()).toEqual({
      offset: 2,
      size: 2,
      complete: true,
    });
  });
  it("supports an empty object without confusing empty staging with publication", async () => {
    const { client } = fixture();
    const session = await createAzureSession(client, { ...options, size: 0 });
    const destination = createAzureUploadDestination(client, session);
    expect((await destination.status()).complete).toBe(false);
    expect((await destination.finish!()).complete).toBe(true);
    expect((await destination.status()).complete).toBe(true);
    expect(destination.terminate).toBeUndefined();
  });
  it("refuses changed backends, source layout, invalid extents and missing identity before IO", async () => {
    const { client, state } = fixture();
    const session = await createAzureSession(client, options);
    const before = state.calls.length;
    expect(() => createAzureUploadDestination(client, { ...session, backend: "other" })).toThrow();
    await expect(createAzureUploadDestination(client, session).write(0, new Uint8Array(1))).rejects.toThrow();
    const { identity: _identity, ...noIdentity } = client;
    await expect(createAzureSession(noIdentity, options)).rejects.toThrow();
    expect(state.calls.length).toBe(before);
  });
  it("rejects shadowed native byte extents before stage requests", async () => {
    const { client, state } = fixture();
    const session = await createAzureSession(client, options);
    const bytes = new Uint8Array(3);
    Object.defineProperty(bytes, "byteLength", { value: 2 });
    await expect(createAzureUploadDestination(client, session).write(0, bytes)).rejects.toThrow();
    expect(state.calls).toEqual(["HEAD:blob"]);
  });
  it("does not trust same-size foreign publication or altered baseline", async () => {
    const { client, state } = fixture();
    const session = await createAzureSession(client, options);
    state.etag = '"another"';
    state.output = new Uint8Array(5);
    await expect(createAzureUploadDestination(client, session).status()).rejects.toThrow();
    state.metadata = { opfs_session: session.token, opfs_size: "5", opfs_block_bytes: "3" };
    await expect(createAzureUploadDestination(client, session).status()).rejects.toThrow();
  });
  it("validates direct block scalars, duplicates, gaps and foreign block IDs", async () => {
    for (
      const fragment of [
        "<Block><Name>foreign</Name><Size>2</Size></Block>",
        "<Block><Wrapper><Name>nested</Name></Wrapper><Size>2</Size></Block>",
        "<Block><Name>a</Name><Name>b</Name><Size>2</Size></Block>",
      ]
    ) {
      const { client, state } = fixture();
      const session = await createAzureSession(client, options);
      state.xml = `<BlockList><UncommittedBlocks>${fragment}</UncommittedBlocks></BlockList>`;
      await expect(createAzureUploadDestination(client, session).status()).rejects.toThrow();
    }
  });
  it("retains known conditional commit failures and refuses blind automatic retry", async () => {
    const { client, state } = fixture();
    const session = await createAzureSession(client, { ...options, size: 2 });
    const destination = createAzureUploadDestination(client, session);
    await destination.write(0, new Uint8Array(2));
    state.commitStatus = 412;
    await expect(destination.finish!()).rejects.toBeInstanceOf(AzureError);
    expect(state.calls.filter((value) => value === "PUT:blocklist").length).toBe(1);
  });
  it("enforces baseline ETag on overwrite and pre-aborted operations have no effects", async () => {
    const { client, state } = fixture();
    state.etag = '"previous"';
    const session = await createAzureSession(client, { ...options, size: 0 });
    expect(session.initialETag).toBe('"previous"');
    const destination = createAzureUploadDestination(client, session);
    const signal = AbortSignal.abort("stop");
    const before = state.calls.length;
    await expect(destination.status({ signal })).rejects.toBe("stop");
    expect(state.calls.length).toBe(before);
    await destination.finish!();
    expect(state.etag).toBe('"published"');
  });
});
