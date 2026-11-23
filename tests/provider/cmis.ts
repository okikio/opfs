import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";
import { collectBytes } from "../../src/stream.ts";
import { readResponse } from "../../src/response.ts";

/** Official Tomcat9/Java8 multiarchitecture index, inspected before archival CMIS fixture acquisition. */
export const CMIS_IMAGE =
  "tomcat:9.0-jdk8-temurin@sha256:340be5aeee31d66d3b0ea39263737e2066f98b96e2832fd85eb58da41c0ce0da";
const WAR_URL =
  "https://repo.maven.apache.org/maven2/org/apache/chemistry/opencmis/chemistry-opencmis-server-inmemory/1.1.0/chemistry-opencmis-server-inmemory-1.1.0.war";
const SDK_URL =
  "https://archive.apache.org/dist/chemistry/opencmis/1.1.0/chemistry-opencmis-client-impl-1.1.0-with-dependencies.zip";
const WAR_SHA256 = "e64213571d416a5ff03a923693b97bb32d680b353af40d6807ce007197ae71d9";
const SDK_SHA256 = "8ee3726aad738ac4b8866aeb9db31a56880ef44678374e1fa043213834aefd2c";
const AUTH = `Basic ${Buffer.from("dummyuser:dummysecret").toString("base64")}`;
/** Native InMemory configuration. No repository filler, host configuration or retained account is consulted. */
const CONFIG = `class=org.apache.chemistry.opencmis.inmemory.server.InMemoryServiceFactoryImpl
repository.id=dummy-rep
repository.name=Disposable CMIS repository
InMemoryServer.RepositoryId=A1
InMemoryServer.User=dummyuser
InMemoryServer.Password=dummysecret
InMemoryServer.TypesCreatorClass=org.apache.chemistry.opencmis.inmemory.types.DefaultTypeSystemCreator
InMemoryServer.TypeDefinitionsFile=types.xml
InMemoryServer.Class=org.apache.chemistry.opencmis.inmemory.storedobj.impl.StoreManagerImpl
InMemoryServer.MaxSize=20971520
InMemoryServer.EncryptTempFiles=true
InMemoryServer.MaxContentSizeKB=4096
RepositoryFiller.Enable=false
`;
/** Independent Apache SDK producer/reader. Base64 preserves complete binary output through text-only container exec. */
const JAVA = `import java.io.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.chemistry.opencmis.client.api.*;
import org.apache.chemistry.opencmis.client.runtime.SessionFactoryImpl;
import org.apache.chemistry.opencmis.commons.PropertyIds;
import org.apache.chemistry.opencmis.commons.SessionParameter;
import org.apache.chemistry.opencmis.commons.data.ContentStream;
import org.apache.chemistry.opencmis.commons.enums.*;
import org.apache.chemistry.opencmis.commons.impl.dataobjects.ContentStreamImpl;
public class Oracle {
  static String encode(String text) { return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8)); }
  public static void main(String[] args) throws Exception {
    Map<String,String> p = new HashMap<String,String>();
    p.put(SessionParameter.BINDING_TYPE, BindingType.BROWSER.value());
    p.put(SessionParameter.BROWSER_URL, "http://cmis.test:8080/cmis/browser");
    p.put(SessionParameter.REPOSITORY_ID, "A1");
    p.put(SessionParameter.USER, "dummyuser"); p.put(SessionParameter.PASSWORD, "dummysecret");
    p.put(SessionParameter.CONNECT_TIMEOUT, "10000"); p.put(SessionParameter.READ_TIMEOUT, "20000");
    Session s = SessionFactoryImpl.newInstance().createSession(p);
    System.out.println("SDK:" + SessionFactoryImpl.class.getPackage().getImplementationVersion());
    System.out.println("ROOT:" + encode(s.getRootFolder().getId()));
    if (args[0].equals("seed")) {
      byte[] bytes = Files.readAllBytes(Paths.get("/oracle/input.bin"));
      if (bytes.length > 1048576) throw new IllegalArgumentException("fixture bytes exceed limit");
      Map<String,Object> props = new HashMap<String,Object>();
      props.put(PropertyIds.OBJECT_TYPE_ID, "cmis:document"); props.put(PropertyIds.NAME, args[1]);
      ContentStream content = new ContentStreamImpl(args[1], BigInteger.valueOf(bytes.length), "application/octet-stream", new ByteArrayInputStream(bytes));
      Document d = s.getRootFolder().createDocument(props, content, VersioningState.NONE);
      System.out.println("ID:" + encode(d.getId()));
    } else if (args[0].equals("read")) {
      Document d = (Document)s.getObject(args[1]);
      ContentStream content = d.getContentStream();
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      try (InputStream input = content.getStream()) {
        byte[] buffer = new byte[8192]; int n;
        while ((n = input.read(buffer)) != -1) {
          if (output.size() + n > 1048576) throw new IOException("fixture output exceeds limit");
          output.write(buffer, 0, n);
        }
      }
      System.out.println("BYTES:" + Base64.getEncoder().encodeToString(output.toByteArray()));
      System.out.println("ID:" + encode(d.getId()));
    } else throw new IllegalArgumentException("unsupported fixture operation");
  }
}
`;
/** These exact inspected archives have respectively 82/28 safe relative entries and <11/<7 MiB expanded bytes.
 * SHA256 binds those reviewed byte layouts before native jar extraction; no arbitrary ZIP input is admitted.
 * Legacy publisher SHA1 values are provenance comparisons, not a modern authentication claim.
 */
async function artifact(url: string, hash: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200 || response.body === null) {
    return await readResponse(response, () => {
      throw new Error("CMIS test artifact acquisition failed.");
    });
  }
  const bytes = await collectBytes(response.body, 16 * 1024 * 1024, undefined, "read", "CMIS test artifact");
  if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("CMIS test artifact digest mismatch.");
  return Buffer.from(bytes);
}
function field(output: string, name: string): string {
  const matches = output.split(/\r?\n/u).filter((line) => line.startsWith(`${name}:`));
  if (matches.length !== 1) throw new Error(`Independent CMIS oracle omitted ${name} evidence.`);
  return matches[0]!.slice(name.length + 1);
}
/** One disposable repository and an independent Java client; their configuration and lifecycle belong to this fixture. */
export class CmisFixture implements AsyncDisposable {
  readonly repositoryUrl: string;
  readonly rootUrl: string;
  readonly authorization = AUTH;
  readonly #oracle: StartedTestContainer;
  readonly #resources: readonly (() => Promise<unknown>)[];
  #closure: Promise<void> | undefined;
  constructor(
    server: StartedTestContainer,
    oracle: StartedTestContainer,
    resources: readonly (() => Promise<unknown>)[],
  ) {
    this.repositoryUrl = `http://${server.getHost()}:${server.getMappedPort(8080)}/cmis/browser/A1`;
    this.rootUrl = `${this.repositoryUrl}/root`;
    this.#oracle = oracle;
    this.#resources = [...resources];
  }
  async #command(args: string[]): Promise<string> {
    const result = await this.#oracle.exec([
      "timeout",
      "60",
      "java",
      "-Xmx128m",
      "-cp",
      "/oracle/sdk/*:/oracle",
      "Oracle",
      ...args,
    ]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1024 * 1024) {
      throw new Error(`Independent OpenCMIS client failed: ${result.output.slice(0, 8192)}`);
    }
    if (field(result.output, "SDK") !== "1.1.0") {
      throw new Error("Independent OpenCMIS SDK did not report release1.1.0.");
    }
    return result.output;
  }
  async seed(name: string, bytes: Uint8Array): Promise<{ readonly id: string; readonly root: string }> {
    if (bytes.byteLength > 1024 * 1024) throw new RangeError("CMIS fixture seed exceeds byte policy.");
    const owned = Buffer.from(bytes);
    await this.#oracle.copyContentToContainer([{ content: owned, target: "/oracle/input.bin" }]);
    const output = await this.#command(["seed", name]);
    return {
      id: Buffer.from(field(output, "ID"), "base64").toString("utf8"),
      root: Buffer.from(field(output, "ROOT"), "base64").toString("utf8"),
    };
  }
  async read(id: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(Buffer.from(field(await this.#command(["read", id]), "BYTES"), "base64"));
  }
  close(): Promise<void> {
    return this.#closure ??= close([...this.#resources].reverse());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
/** Testcontainers owns native readiness, partial initialization failures, private network, quotas and reverse teardown. */
export async function openCmis(): Promise<CmisFixture> {
  const war = await artifact(WAR_URL, WAR_SHA256), sdk = await artifact(SDK_URL, SDK_SHA256);
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
    const server = await new NativeContainer(CMIS_IMAGE).withNetwork(network).withNetworkAliases("cmis.test")
      .withCopyContentToContainer([{ content: war, target: "/tmp/cmis.war" }, {
        content: CONFIG,
        target: "/tmp/repository.properties",
      }])
      .withCommand([
        "sh",
        "-c",
        "mkdir -p /usr/local/tomcat/webapps/cmis && cd /usr/local/tomcat/webapps/cmis && jar xf /tmp/cmis.war && cp /tmp/repository.properties WEB-INF/classes/repository.properties && exec catalina.sh run",
      ])
      .withEnvironment({ CATALINA_OPTS: "-Xms32m -Xmx512m" }).withExposedPorts(8080)
      .withResourcesQuota({ memory: 1, cpu: 1 })
      .withLogConsumer((stream) => {
        stream.on("data", (chunk) => console.error("CMIS bootstrap:", String(chunk).trim()));
        stream.on("err", (chunk) => console.error("CMIS bootstrap:", String(chunk).trim()));
      })
      .withWaitStrategy(
        Wait.forHttp("/cmis/browser", 8080, { abortOnContainerExit: true }).withBasicCredentials(
          "dummyuser",
          "dummysecret",
        ).forStatusCode(200),
      )
      .withStartupTimeout(120_000).start();
    resources.push(() => server.stop());
    const oracle = await new GenericContainer(CMIS_IMAGE).withNetwork(network)
      .withCopyContentToContainer([{ content: sdk, target: "/tmp/sdk.zip" }, {
        content: JAVA,
        target: "/oracle/Oracle.java",
      }])
      .withCommand([
        "sh",
        "-c",
        "mkdir -p /oracle/sdk && cd /oracle/sdk && jar xf /tmp/sdk.zip && javac -J-Xmx128m -cp '/oracle/sdk/*' /oracle/Oracle.java && exec sleep 600",
      ])
      .withResourcesQuota({ memory: 0.5, cpu: 0.5 })
      .withWaitStrategy(Wait.forSuccessfulCommand("test -f /oracle/Oracle.class")).withStartupTimeout(60_000).start();
    resources.push(() => oracle.stop());
    return new CmisFixture(server, oracle, resources);
  } catch (reason) {
    if (nativeId !== undefined) {
      try {
        console.error(
          "CMIS native bootstrap failure:",
          execFileSync("docker", ["logs", nativeId], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }),
        );
      } catch (diagnostic) {
        console.error("CMIS bootstrap diagnostic unavailable:", diagnostic);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
