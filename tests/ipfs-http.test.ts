import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { close } from "../src/close.ts";
import { openIpfsSource } from "../src/ipfs.ts";

const hello = "f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const raw = "bafkreifw7plhl6mofk6sfvhnfh64qmkq73oeqwl6sloru6rehaoujituke";
const dag = "bafyreihyrpefhacm6kkp4ql6j6udakdit7g3dmkzfriqfykhjw6cad5lrm";
const fixture = async (): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await readFile(new URL("./fixtures/car/carv1-basic.car", import.meta.url)));

describe("IPFS independent CAR and HTTP interoperability", () => {
  it("verifies a producer raw block and rejects a missing requested root", async () => {
    const bytes = await fixture();
    const fetch = (input: string | URL | Request) => {
      expect(new URL(String(input)).searchParams.get("dag-scope")).toBe("block");
      return Promise.resolve(
        new Response(bytes, { headers: { "content-type": "application/vnd.ipld.car; version=1" } }),
      );
    };
    const source = await openIpfsSource(raw, { gateway: "https://gateway.invalid", mode: "verified-car", fetch });
    expect(new TextDecoder().decode(await source.read(0, 4))).toBe("cccc");
    expect(source.representation).toBe("raw-block");
    await expect(openIpfsSource(hello, { gateway: "https://gateway.invalid", mode: "verified-car", fetch })).rejects
      .toThrow("absent");
  });
  it("runs actual HTTP requests against a disposable protocol server for raw, CAR and trusted ranges", async () => {
    const car = await fixture();
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://fixture.invalid");
      if (url.searchParams.get("format") === "raw") {
        response.writeHead(200, { "content-type": "application/vnd.ipld.raw", "content-length": "5" });
        response.end("hello");
      } else if (url.searchParams.get("format") === "car") {
        response.writeHead(200, {
          "content-type": "application/vnd.ipld.car; version=1",
          "content-length": String(car.length),
        });
        response.end(car);
      } else if (request.method === "HEAD") {
        response.writeHead(200, { "content-length": "5", etag: '"fixture"' });
        response.end();
      } else {
        expect(request.headers.range).toBe("bytes=1-3");
        expect(request.headers["if-match"]).toBe('"fixture"');
        response.writeHead(206, { "content-range": "bytes 1-3/5", "content-length": "3", etag: '"fixture"' });
        response.end("ell");
      }
    });
    let primary: readonly unknown[] = [];
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing fixture port");
      const gateway = `http://127.0.0.1:${address.port}`;
      const source = await openIpfsSource(hello, { gateway, mode: "verified-raw" });
      expect(new TextDecoder().decode(await source.read(0, 5))).toBe("hello");
      const fromCar = await openIpfsSource(raw, { gateway, mode: "verified-car" });
      expect(new TextDecoder().decode(await fromCar.read(0, 4))).toBe("cccc");
      const trusted = await openIpfsSource(dag, { gateway, mode: "trusted" });
      expect(new TextDecoder().decode(await trusted.read(1, 3))).toBe("ell");
    } catch (reason) {
      primary = [reason];
    }
    await close([async () => {
      if (!server.listening) return;
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
      server.closeAllConnections();
      await stopped;
    }], primary);
  });
});
