import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { close } from "../../src/close.ts";
import type { StartedTestContainer } from "testcontainers";

/** Official server and isolated test-only Node/Nano oracle. No SDK enters the production dependency graph. */
export const COUCHDB_IMAGE = "couchdb:3.5.3@sha256:907eab5b7e55ab7cfd241d39b90b2a335ea40bef82acee5a37388c08bf201dda";
export const COUCHDB_ORACLE_IMAGE =
  "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94";
const AUTH = `Basic ${Buffer.from("fixture:disposable-only").toString("base64")}`;
/** Native configuration, not an auth proxy. single_node creates system databases; chttpd forces authentication, including reads. */
const CONFIG = `[couchdb]
single_node = true
[chttpd]
require_valid_user = true
`;
const PACKAGE = JSON.stringify({
  name: "couchdb-independent-oracle",
  version: "1.0.0",
  private: true,
  dependencies: { nano: "11.0.8" },
});
/** Nano11.0.8 has zero dependencies. npm ci verifies this exact registry tarball integrity with all install scripts disabled. */
const LOCK = JSON.stringify({
  name: "couchdb-independent-oracle",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "couchdb-independent-oracle", version: "1.0.0", dependencies: { nano: "11.0.8" } },
    "node_modules/nano": {
      version: "11.0.8",
      resolved: "https://registry.npmjs.org/nano/-/nano-11.0.8.tgz",
      integrity: "sha512-sOm7K74erwg4Vti32zdvz6YCg2aW9bfuL7BMQhPInARp2QEQroo+DXpC5dBLHKuBMjbfHPcyinX2fk/6RMBShg==",
      license: "Apache-2.0",
      engines: { node: ">=22.0" },
    },
  },
});
/** Independent official SDK operations, bounded by an external timeout and copied byte files rather than shell interpolation.
 * Nano appends attName without encoding (pinned lib/nano.js335-336); only its attachment argument needs encodeURIComponent.
 * The candidate retains its own literal-ID URL construction unchanged.
 */
const ORACLE = `const fs=require('node:fs');
const Nano=require('nano');
const timer=setTimeout(()=>{console.error('oracle deadline');process.exit(2)},30000);
const auth='Basic '+Buffer.from('fixture:disposable-only').toString('base64');
const server=Nano({url:'http://couchdb.test:5984',headers:{Authorization:auth}});
const db=server.use('fixture');
const [op,id,name]=process.argv.slice(2);
(async()=>{
 if(op==='init') { const v=await server.info(); if(v.version!=='3.5.3')throw Error('native version mismatch'); await server.db.create('fixture'); console.log('VERSION:'+v.version); }
 else if(op==='seed') {const bytes=fs.readFileSync('/oracle/input.bin');if(bytes.length>1048576)throw Error('fixture size');const receipt=await db.attachment.insert(id,encodeURIComponent(name),bytes,'application/octet-stream');console.log('RECEIPT:'+JSON.stringify(receipt));}
 else if(op==='read') {const bytes=await db.attachment.get(id,encodeURIComponent(name));if(bytes.length>1048576)throw Error('fixture size');console.log('BYTES:'+bytes.toString('base64'));}
 else throw Error('unsupported fixture action');
})().then(()=>clearTimeout(timer),e=>{console.error(e);process.exitCode=1;clearTimeout(timer)});
`;
function field(output: string, name: string): string {
  const rows = output.split(/\r?\n/u).filter((line) => line.startsWith(`${name}:`));
  if (rows.length !== 1) throw new Error(`CouchDB oracle omitted ${name} evidence.`);
  return rows[0]!.slice(name.length + 1);
}
/** Only these disposable resources are owned; no ambient credentials, host paths, ports or configuration are borrowed. */
export class CouchdbFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly database = "fixture";
  readonly authorization = AUTH;
  readonly #oracle: StartedTestContainer;
  readonly #resources: readonly (() => Promise<unknown>)[];
  #closure: Promise<void> | undefined;
  constructor(
    server: StartedTestContainer,
    oracle: StartedTestContainer,
    resources: readonly (() => Promise<unknown>)[],
  ) {
    this.endpoint = `http://${server.getHost()}:${server.getMappedPort(5984)}/`;
    this.#oracle = oracle;
    this.#resources = [...resources];
  }
  async #command(args: string[]): Promise<string> {
    const result = await this.#oracle.exec([
      "timeout",
      "45",
      "node",
      "--max-old-space-size=128",
      "/oracle/oracle.cjs",
      ...args,
    ]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1024 * 1024) {
      throw new Error(`Independent Nano oracle failed: ${result.output.slice(0, 8192)}`);
    }
    return result.output;
  }
  async init(): Promise<void> {
    if (field(await this.#command(["init"]), "VERSION") !== "3.5.3") throw new Error("Wrong CouchDB native version.");
  }
  async seed(id: string, name: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > 1024 * 1024) throw new RangeError("CouchDB fixture seed budget.");
    const owned = Buffer.from(bytes);
    await this.#oracle.copyContentToContainer([{ content: owned, target: "/oracle/input.bin" }]);
    const output = await this.#command(["seed", id, name]);
    const result: unknown = JSON.parse(field(output, "RECEIPT"));
    if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) {
      throw new Error("SDK seed receipt invalid.");
    }
  }
  async read(id: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(Buffer.from(field(await this.#command(["read", id, name]), "BYTES"), "base64"));
  }
  close(): Promise<void> {
    return this.#closure ??= close([...this.#resources].reverse());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
/** Review this complete recipe before first native execution; partial initialization and bootstrap diagnostics are retained. */
export async function openCouchdb(): Promise<CouchdbFixture> {
  const { GenericContainer, Network, Wait } = await import("testcontainers");
  const resources: (() => Promise<unknown>)[] = [];
  let nativeId: string | undefined;
  class NativeContainer extends GenericContainer {
    protected override containerCreated(id: string): Promise<void> {
      nativeId = id;
      return Promise.resolve();
    }
  }
  try {
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new NativeContainer(COUCHDB_IMAGE).withNetwork(network).withNetworkAliases("couchdb.test")
      .withEnvironment({
        COUCHDB_USER: "fixture",
        COUCHDB_PASSWORD: "disposable-only",
        COUCHDB_ERLANG_COOKIE: "disposable-fixture-cookie",
      })
      .withCopyContentToContainer([{ content: CONFIG, target: "/opt/couchdb/etc/local.d/fixture.ini" }])
      .withExposedPorts(5984).withResourcesQuota({ memory: 1, cpu: 1 })
      .withWaitStrategy(
        Wait.forHttp("/_up", 5984, { abortOnContainerExit: true }).withBasicCredentials("fixture", "disposable-only")
          .forStatusCode(200),
      )
      .withStartupTimeout(90_000).start();
    resources.push(() => server.stop());
    const oracle = await new GenericContainer(COUCHDB_ORACLE_IMAGE).withNetwork(network)
      .withCopyContentToContainer([{ content: PACKAGE, target: "/oracle/package.json" }, {
        content: LOCK,
        target: "/oracle/package-lock.json",
      }, { content: ORACLE, target: "/oracle/oracle.cjs" }])
      .withWorkingDir("/oracle").withCommand([
        "sh",
        "-c",
        "timeout 90 npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=60000 && touch /oracle/ready && exec sleep 600",
      ])
      .withLogConsumer((stream) => {
        stream.on("data", (chunk) => console.error("Nano setup:", String(chunk).trim()));
        stream.on("err", (chunk) => console.error("Nano setup:", String(chunk).trim()));
      })
      .withResourcesQuota({ memory: 0.5, cpu: 0.5 }).withWaitStrategy(
        Wait.forSuccessfulCommand("test -f /oracle/ready"),
      ).withStartupTimeout(120_000).start();
    resources.push(() => oracle.stop());
    const fixture = new CouchdbFixture(server, oracle, resources);
    await fixture.init();
    return fixture;
  } catch (reason) {
    if (nativeId !== undefined) {
      try {
        console.error(
          "CouchDB bootstrap:",
          execFileSync("docker", ["logs", nativeId], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }),
        );
      } catch (diagnostic) {
        console.error("CouchDB bootstrap diagnostics unavailable:", diagnostic);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
