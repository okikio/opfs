import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { SeafileClient, SeafileError } from "../src/seafile.ts";
import { close } from "../src/close.ts";
import { startSeafile } from "./provider/seafile.ts";

function id(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
    throw new Error("Official Seafile SDK omitted its library identity.");
  }
  return value.id;
}
function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "object" || value === null || !("bytes" in value) || typeof value.bytes !== "string") {
    throw new Error("Official Seafile SDK omitted its complete bytes.");
  }
  return new Uint8Array(Buffer.from(value.bytes, "base64"));
}

describe("Seafile CE14 and official Python SDK interoperability", () => {
  it(
    "preserves complete bytes, actual collision names, replacement and library permissions",
    { timeout: 600_000 },
    async () => {
      const fixture = await startSeafile();
      let primary: readonly unknown[] = [];
      try {
        const info = await fetch(new URL("api2/server-info/", fixture.endpoint));
        const server = await info.json() as { version?: string };
        if (!server.version?.startsWith("14.")) {
          throw new Error(
            "Seafile fixture did not report the selected CE14 profile.",
          );
        }
        console.info(`Seafile packaged server version: ${server.version}`);
        const library = id(await fixture.oracle("create", "fixture"));
        const options = {
          endpoint: fixture.endpoint,
          library,
          token: fixture.token,
          allowHttp: true,
          downloadGrants: [{ origin: fixture.endpoint, prefix: "/seafhttp/" }],
          uploadGrants: [{ origin: fixture.endpoint, prefix: "/seafhttp/" }],
          policy: { retries: 0 },
        };
        const client = new SeafileClient(options);
        const expected = new Uint8Array([0, 17, 255, 42, 9]);
        await fixture.oracle("upload", library, Buffer.from(expected).toString("base64"));
        const linkUrl = new URL(`api2/repos/${library}/file/`, fixture.endpoint);
        linkUrl.search = new URLSearchParams({ p: "/oracle-input", reuse: "0" }).toString();
        const linkResponse = await fetch(linkUrl, {
          headers: { authorization: `Token ${fixture.token}` },
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        const nativeLink: unknown = await linkResponse.json();
        if (!linkResponse.ok || typeof nativeLink !== "string") {
          throw new Error("Native capability receipt is malformed.");
        }
        const authority = new URL(nativeLink);
        expect(authority.origin).toBe(new URL(fixture.endpoint).origin);
        expect(authority.pathname.startsWith("/seafhttp/")).toBe(true);
        console.info("Seafile native capability authority:", authority.origin, "/seafhttp/");
        expect(await client.read("/oracle-input")).toEqual(expected);
        expect(await client.read("/oracle-input", { at: 1, length: 3 })).toEqual(expected.slice(1, 4));
        expect((await client.stat("/oracle-input")).size).toBe(expected.length);
        const first = await client.upload("/", "candidate.bin", expected);
        expect(first.name).toBe("candidate.bin");
        expect(bytes(await fixture.oracle("read", library, `/${first.name}`))).toEqual(expected);
        const changed = new Uint8Array([8, 7, 6]);
        const collision = await client.upload("/", "candidate.bin", changed);
        expect(collision.name).not.toBe(first.name);
        expect(bytes(await fixture.oracle("read", library, `/${collision.name}`))).toEqual(changed);
        expect(bytes(await fixture.oracle("read", library, `/${first.name}`))).toEqual(expected);
        const replacement = await client.upload("/", "candidate.bin", changed, { replace: true });
        expect(replacement.name).toBe("candidate.bin");
        expect(bytes(await fixture.oracle("read", library, "/candidate.bin"))).toEqual(changed);
        expect((await client.list()).map((value) => value.name)).toContain(collision.name);
        const encrypted = id(await fixture.oracle("create", "encrypted", "fixture-encryption-password"));
        const encryptedClient = new SeafileClient({ ...options, library: encrypted });
        expect((await encryptedClient.getLibrary()).encrypted).toBe(true);
        await expect(encryptedClient.upload("/", "refused.bin", expected)).rejects.toBeInstanceOf(TypeError);
        const wrong = new SeafileClient({ ...options, token: "invalid-user-token" });
        await expect(wrong.getLibrary()).rejects.toBeInstanceOf(SeafileError);

        // Native user/share administration is fixture setup, separate from the candidate's production capabilities.
        const viewer = "viewer@example.test", password = "viewer-password-123456";
        const create = await fetch(new URL("api/v2.1/admin/users/", fixture.endpoint), {
          method: "POST",
          headers: { authorization: `Token ${fixture.token}` },
          body: new URLSearchParams({ email: viewer, password, is_staff: "false", is_active: "true" }),
        });
        const created: unknown = await create.json();
        if (
          !create.ok || typeof created !== "object" || created === null || !("email" in created) ||
          typeof created.email !== "string"
        ) throw new Error(`Seafile native read-only user setup failed with HTTP ${create.status}.`);
        // CE14 returns a native virtual username distinct from the contact/login email.
        const nativeViewer = created.email;
        const share = new URL(`api2/shared-repos/${library}/`, fixture.endpoint);
        share.search = new URLSearchParams({ share_type: "personal", permission: "r", user: nativeViewer }).toString();
        const shared = await fetch(share, { method: "PUT", headers: { authorization: `Token ${fixture.token}` } });
        await shared.arrayBuffer();
        if (!shared.ok) throw new Error(`Seafile native library share setup failed with HTTP ${shared.status}.`);
        const login = await fetch(new URL("api2/auth-token/", fixture.endpoint), {
          method: "POST",
          body: new URLSearchParams({ username: viewer, password }),
        });
        const viewerAuth = await login.json() as { token?: string };
        if (!login.ok || typeof viewerAuth.token !== "string") throw new Error("Seafile native viewer login failed.");
        const reader = new SeafileClient({ ...options, token: viewerAuth.token });
        expect(await reader.read("/candidate.bin")).toEqual(changed);
        await expect(reader.upload("/", "forbidden.bin", expected)).rejects.toMatchObject({ status: 403 });
      } catch (reason) {
        primary = [reason];
        throw reason;
      } finally {
        await close([() => fixture.close()], primary);
      }
    },
  );
});
