import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Official 33.0.8 Apache multiarch index inspected 2026-11-05. Local SQLite storage does not prove multipart offload. */
export const NEXTCLOUD_IMAGE = "nextcloud@sha256:9ed3924f92f651aab622b23557b3f3dbcf04f7678567f50a41dbace2463c0a52";
export const NEXTCLOUD_ORACLE_BYTES = "independent bundled SabreDAV producer bytes\n";
/** Bundled SabreDAV parses replies and independently writes/reads full bytes through actual HTTP. */
const oracle = `<?php
require '/var/www/html/3rdparty/autoload.php';
$client = new Sabre\\DAV\\Client(['baseUri'=>'http://127.0.0.1/remote.php/dav/files/fixture/','userName'=>'fixture','password'=>'fixture-password-1234']);
$action=$argv[1];$name=$argv[2]??'oracle.txt';
if($action==='produce') { $result=$client->request('PUT',rawurlencode($name),${
  JSON.stringify(NEXTCLOUD_ORACLE_BYTES)
}); if($result['statusCode']!==201)throw new Exception('Oracle PUT failed'); echo 'true'; }
elseif($action==='read') { $result=$client->request('GET',rawurlencode($name));if($result['statusCode']!==200)throw new Exception('Oracle GET failed');echo json_encode($result['body']); }
elseif($action==='check') { $result=$client->request('GET',rawurlencode($name));if($result['statusCode']!==200)throw new Exception('Oracle GET failed');$size=(int)$argv[3];$pattern='';for($i=0;$i<251;$i++)$pattern.=chr($i);$expected=substr(str_repeat($pattern,(int)ceil($size/251)),0,$size);if($result['body']!==$expected)throw new Exception('Full native reader bytes differ');echo json_encode(['size'=>strlen($result['body']),'equal'=>true]); }
elseif($action==='missing') { try{$result=$client->request('GET',rawurlencode($name));echo json_encode($result['statusCode']===404);}catch(Sabre\\HTTP\\ClientHttpException $e){if($e->getHttpStatus()!==404)throw $e;echo 'true';} }
else throw new Exception('Unknown oracle action');
`;

/** Disposable native server; callers close it even after assertions fail. No account or host configuration is discovered. */
export class NextcloudFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly authorization = "Basic Zml4dHVyZTpmaXh0dXJlLXBhc3N3b3JkLTEyMzQ=";
  readonly #container: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(container: StartedTestContainer) {
    this.#container = container;
    this.endpoint = `http://${container.getHost()}:${container.getMappedPort(80)}/`;
  }
  close(): Promise<void> {
    return this.#closure ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  async oracle(action: "produce" | "read" | "check" | "missing", name: string, size?: number): Promise<unknown> {
    const result = await this.#container.exec([
      "php",
      "/tmp/nextcloud-oracle.php",
      action,
      name,
      ...(size === undefined ? [] : [String(size)]),
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent SabreDAV oracle failed: ${result.output}`);
    return JSON.parse(result.output);
  }
}

/** Testcontainers owns mapped ports, native HTTP readiness, resource bounds and partial-acquisition cleanup. */
export async function startNextcloud(): Promise<NextcloudFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  let container: StartedTestContainer | undefined;
  try {
    container = await new GenericContainer(NEXTCLOUD_IMAGE).withExposedPorts(80)
      .withEnvironment({
        SQLITE_DATABASE: "fixture",
        NEXTCLOUD_ADMIN_USER: "fixture",
        NEXTCLOUD_ADMIN_PASSWORD: "fixture-password-1234",
        NEXTCLOUD_TRUSTED_DOMAINS: "localhost 127.0.0.1 host.docker.internal",
      })
      .withCopyContentToContainer([{ content: oracle, target: "/tmp/nextcloud-oracle.php" }])
      .withResourcesQuota({ memory: 1, cpu: 1 })
      .withWaitStrategy(Wait.forHttp("/status.php", 80).forStatusCode(200)).withStartupTimeout(180_000).start();
    return new NextcloudFixture(container);
  } catch (reason) {
    await close(container === undefined ? [] : [() => container!.stop()], [reason]);
    throw reason;
  }
}
