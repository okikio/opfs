import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** Official image indexes inspected with buildx2026-11-05; no floating tag controls execution. */
export const SUPABASE_IMAGE =
  "supabase/storage-api@sha256:8526956cb462e9f7d392e9848ec77133b2769982ed614e9753cc687e8e4339a6";
export const SUPABASE_POSTGRES_IMAGE =
  "pgvector/pgvector@sha256:88164492558c9773a1e17a8305abaca7863e05b3d8bbcdb792774890a2047e06";
export const SUPABASE_NODE_IMAGE = "node@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
export const SUPABASE_BYTES = "independent official storage-js producer bytes\n";
const PORT = 5000,
  SECRET = "fixture-only-supabase-signing-secret-not-production",
  USER = "11111111-1111-4111-8111-111111111111",
  OTHER = "22222222-2222-4222-8222-222222222222";
/** These explicit test issuers exercise Storage JWT/RLS, not GoTrue login or hosted gateway authentication. */
function jwt(role: string, sub?: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = [{ alg: "HS256", typ: "JWT" }, {
    role,
    aud: "authenticated",
    iat,
    exp: iat + 3600,
    ...(sub === undefined ? {} : { sub }),
  }].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return unsigned + "." + createHmac("sha256", SECRET).update(unsigned).digest("base64url");
}
/** Locally adapted minimal auth schema. Upstream setup remains research, not an executed fixture script. */
const auth = `CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
INSERT INTO auth.users VALUES('${USER}'),('${OTHER}');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role') $$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
`;
const policies =
  `CREATE POLICY fixture_select ON storage.objects FOR SELECT TO authenticated USING(bucket_id='private' AND auth.uid()='${USER}'::uuid AND name LIKE 'allowed/%');
CREATE POLICY fixture_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='private' AND auth.uid()='${USER}'::uuid AND name LIKE 'allowed/%');
CREATE POLICY fixture_update ON storage.objects FOR UPDATE TO authenticated USING(bucket_id='private' AND auth.uid()='${USER}'::uuid AND name LIKE 'allowed/%') WITH CHECK(bucket_id='private' AND auth.uid()='${USER}'::uuid AND name LIKE 'allowed/%');
CREATE POLICY fixture_delete ON storage.objects FOR DELETE TO authenticated USING(bucket_id='private' AND auth.uid()='${USER}'::uuid AND name LIKE 'allowed/%');
`;
const dockerfile = `FROM ${SUPABASE_NODE_IMAGE}
WORKDIR /fixture
COPY download.ts sdk.ts ./
RUN node download.ts && tar -xzf sdk.tgz && rm sdk.tgz && chown -R node:node /fixture
USER node
CMD ["node","-e","console.log('oracle ready');setInterval(()=>{},2147483647)"]
`;
/** Owns the real service, database and independent SDK oracle; no host credentials or configuration are imported. */
export class SupabaseFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly user: string;
  readonly other: string;
  readonly service: string;
  readonly #network: StartedNetwork;
  readonly #containers: readonly StartedTestContainer[];
  readonly #oracle: StartedTestContainer;
  #closure: Promise<void> | undefined;
  constructor(
    network: StartedNetwork,
    database: StartedTestContainer,
    server: StartedTestContainer,
    oracle: StartedTestContainer,
    tokens: { user: string; other: string; service: string },
  ) {
    this.#network = network;
    this.#containers = [oracle, server, database];
    this.#oracle = oracle;
    this.endpoint = `http://${server.getHost()}:${server.getMappedPort(PORT)}/`;
    this.user = tokens.user;
    this.other = tokens.other;
    this.service = tokens.service;
  }
  close(): Promise<void> {
    return this.#closure ??= close([
      ...this.#containers.map((container) => () => container.stop()),
      () => this.#network.stop(),
    ]);
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  async sdk(action: "read" | "list", bucket: string, path: string): Promise<unknown> {
    const result = await this.#oracle.exec(["node", "/fixture/sdk.ts", action, bucket, path]);
    if (result.exitCode !== 0) throw new Error(`Independent Supabase SDK failed: ${result.output}`);
    return JSON.parse(result.stdout.trim()) as unknown;
  }
}
/** Testcontainers controls the private network, mapped-port readiness and reverse-order partial-construction cleanup. */
export async function openSupabaseFixture(): Promise<SupabaseFixture> {
  const { GenericContainer, Network, Wait } = await import("testcontainers");
  const releases: (() => Promise<unknown>)[] = [];
  const directory = await mkdtemp(join(tmpdir(), "opfs-supabase-"));
  try {
    await Promise.all([
      writeFile(join(directory, "Dockerfile"), dockerfile),
      writeFile(
        join(directory, "sdk.ts"),
        await readFile(fileURLToPath(new URL("../fixtures/supabase/sdk.ts", import.meta.url).href)),
      ),
      writeFile(
        join(directory, "download.ts"),
        await readFile(fileURLToPath(new URL("../fixtures/supabase/download.ts", import.meta.url).href)),
      ),
    ]);
    const image = await GenericContainer.fromDockerfile(directory).build();
    await rm(directory, { recursive: true, force: true });
    const network = await new Network().start();
    releases.push(() => network.stop());
    const database = await new GenericContainer(SUPABASE_POSTGRES_IMAGE).withNetwork(network).withNetworkAliases(
      "database",
    )
      .withEnvironment({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "fixture-password", POSTGRES_DB: "postgres" })
      .withCopyContentToContainer([{ content: auth, target: "/docker-entrypoint-initdb.d/fixture.sql" }])
      .withResourcesQuota({ memory: 0.5, cpu: 1 }).withWaitStrategy(
        Wait.forLogMessage("database system is ready to accept connections", 2),
      ).withStartupTimeout(90_000).start();
    releases.push(() => database.stop());
    const tokens = {
      user: jwt("authenticated", USER),
      other: jwt("authenticated", OTHER),
      service: jwt("service_role"),
    };
    const server = await new GenericContainer(SUPABASE_IMAGE).withNetwork(network).withNetworkAliases("storage")
      .withExposedPorts(PORT)
      .withEnvironment({
        SERVER_PORT: String(PORT),
        AUTH_JWT_SECRET: SECRET,
        AUTH_JWT_ALGORITHM: "HS256",
        SERVICE_KEY: tokens.service,
        ANON_KEY: jwt("anon"),
        DATABASE_URL: "postgres://postgres:fixture-password@database:5432/postgres",
        DB_INSTALL_ROLES: "true",
        STORAGE_BACKEND: "file",
        FILE_STORAGE_BACKEND_PATH: "/tmp/fixture-storage",
        STORAGE_S3_BUCKET: "fixture-physical",
        TENANT_ID: "fixture",
        REGION: "local",
        UPLOAD_FILE_SIZE_LIMIT: "1048576",
        IMAGE_TRANSFORMATION_ENABLED: "false",
        S3_PROTOCOL_ENABLED: "false",
      })
      .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges").withResourcesQuota({ memory: 0.75, cpu: 1 })
      .withWaitStrategy(Wait.forHttp("/status", PORT).forStatusCode(200)).withStartupTimeout(120_000).start();
    releases.push(() => server.stop());
    const oracle = await image.withNetwork(network).withEnvironment({ SERVICE_TOKEN: tokens.service })
      .withResourcesQuota({ memory: 0.25, cpu: 0.5 }).withWaitStrategy(Wait.forLogMessage("oracle ready")).start();
    releases.push(() => oracle.stop());
    const setup = await oracle.exec(["node", "/fixture/sdk.ts", "setup"]);
    if (setup.exitCode !== 0) throw new Error(`Native Supabase SDK setup failed: ${setup.output}`);
    const result = await database.exec([
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      policies,
    ]);
    if (result.exitCode !== 0) throw new Error(`Native Supabase RLS setup failed: ${result.output}`);
    return new SupabaseFixture(network, database, server, oracle, tokens);
  } catch (reason) {
    await close([...releases.toReversed(), () => rm(directory, { recursive: true, force: true })], [reason]);
    throw reason;
  }
}
