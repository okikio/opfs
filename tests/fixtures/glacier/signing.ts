/** Captures independent public Smithy request signing without candidate imports.
 *
 * The frozen signatures came from signing.mjs.snapshot. Run this TypeScript
 * port only in a separately reviewed offline oracle refresh.
 */
import process from "node:process";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

/** This boundary mirrors the selected public Smithy declarations, not its private implementation. */
type SourceType = string | ArrayBuffer | ArrayBufferView;
type HashType = {
  update(value: SourceType, encoding?: "utf8" | "ascii" | "latin1"): void;
  digest(): Promise<Uint8Array>;
  reset(): void;
};
type HashConstructorType = new (secret?: SourceType) => HashType;
type RequestType = {
  protocol: string;
  hostname: string;
  port?: number;
  method: string;
  path: string;
  query: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body: Uint8Array;
};
type CredentialsType = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
interface Signer {
  sign(request: RequestType, options: { signingDate: Date }): Promise<RequestType>;
  sign(text: string, options: { signingDate: Date }): Promise<string>;
}
type SignatureModuleType = {
  SignatureV4: new (options: {
    credentials: CredentialsType;
    region: string;
    service: string;
    sha256: HashConstructorType;
    uriEscapePath: boolean;
    applyChecksum: boolean;
  }) => Signer;
  getCanonicalHeaders(request: RequestType): Record<string, string>;
  getCanonicalQuery(request: RequestType): string;
  getPayloadHash(request: RequestType, hash: HashConstructorType): Promise<string>;
  clearCredentialCache(): void;
};
type VectorType = Omit<RequestType, "body"> & {
  id: string;
  credentials: CredentialsType;
  region: string;
  service: string;
  uriEscapePath: boolean;
  signingDate: string;
  canonicalPath: string;
  bodyVector: string;
  treeVector?: string;
  purpose?: string;
};
type OriginalType = { id: string; file: string; size: number; sha256: string };

const [originalsPath, treePath, outputPath] = process.argv.slice(2);
if (process.argv.length !== 5 || originalsPath === undefined || treePath === undefined || outputPath === undefined) {
  throw new Error("Use signing.ts ORIGINAL_DIRECTORY TREE_JSON NEW_OUTPUT_DIRECTORY");
}
// Anchor resolution in an already approved direct test dependency. These calls
// resolve public entrypoints; they neither import a full S3 client nor install.
const repositoryRequire = createRequire(new URL("../../../package.json", import.meta.url));
const sdkRequire = createRequire(repositoryRequire.resolve("@aws-sdk/client-s3"));
const provenance: {
  selectedClosure: { name: string; version: string; files: { path: string; bytes: number; sha256: string }[] }[];
} = JSON.parse(await readFile(new URL("./installed-provenance.json", import.meta.url), "utf8"));
for (const admitted of provenance.selectedClosure) {
  const packageFile = sdkRequire.resolve(`${admitted.name}/package.json`);
  const packageRoot = dirname(packageFile);
  const metadata = JSON.parse(await readFile(packageFile, "utf8"));
  if (metadata.name !== admitted.name || metadata.version !== admitted.version) {
    throw new Error("Independent package identity changed");
  }
  for (const file of admitted.files) {
    const bytes = await readFile(resolve(packageRoot, file.path));
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Independent package bytes changed: ${admitted.name}/${file.path}`);
    }
  }
}
const { SignatureV4, getCanonicalHeaders, getCanonicalQuery, getPayloadHash, clearCredentialCache } = sdkRequire(
  "@smithy/signature-v4",
) as SignatureModuleType;
const { Hash } = sdkRequire("@smithy/core/serde") as { Hash: new (algorithm: string, secret?: SourceType) => HashType };
const Sha256 = Hash.bind(null, "sha256");
const originalsDirectory = resolve(originalsPath);
const originalManifest: { vectors: OriginalType[] } = JSON.parse(
  await readFile(resolve(originalsDirectory, "originals.json"), "utf8"),
);
const treeManifest: { vectors: { id: string; size: number; linearSha256: string; treeHash: string }[] } = JSON.parse(
  await readFile(resolve(treePath), "utf8"),
);
const specification: { vectors: VectorType[] } = JSON.parse(
  await readFile(new URL("./signing-vectors.json", import.meta.url), "utf8"),
);
const output = resolve(outputPath);
await mkdir(output, { recursive: false });
const receipts = [];
try {
  clearCredentialCache();
  for (const vector of specification.vectors) {
    if (!/^[a-z0-9-]+$/.test(vector.id)) throw new Error("Signing fixture id admission failed");
    const original = originalManifest.vectors.find((value) => value.id === vector.bodyVector);
    if (!original || !/^[a-z0-9-]+\.bin$/.test(original.file) || original.size > 16 * 1024 * 1024) {
      throw new Error("Unknown or oversized original body");
    }
    const body = new Uint8Array(await readFile(resolve(originalsDirectory, original.file)));
    const actualBodyHash = createHash("sha256").update(body).digest("hex");
    if (body.length !== original.size || actualBodyHash !== original.sha256) {
      throw new Error("Original complete body changed");
    }
    const headers = { ...vector.headers };
    if (vector.treeVector) {
      const tree = treeManifest.vectors.find((value) => value.id === vector.treeVector);
      const treeOriginal = originalManifest.vectors.find((value) => value.id === vector.treeVector);
      if (
        !tree || !treeOriginal || tree.size !== treeOriginal.size || tree.linearSha256 !== treeOriginal.sha256 ||
        !/^[a-f0-9]{64}$/.test(tree.treeHash)
      ) throw new Error("Missing or mismatched independent official tree value");
      headers["x-amz-sha256-tree-hash"] = tree.treeHash;
    }
    const request = {
      protocol: vector.protocol,
      hostname: vector.hostname,
      ...(vector.port === undefined ? {} : { port: vector.port }),
      method: vector.method,
      path: vector.path,
      query: vector.query,
      headers,
      body,
    };
    const signer = new SignatureV4({
      credentials: vector.credentials,
      region: vector.region,
      service: vector.service,
      sha256: Sha256,
      uriEscapePath: vector.uriEscapePath,
      applyChecksum: true,
    });
    const signed = await signer.sign(request, { signingDate: new Date(vector.signingDate) });
    const canonicalHeaders = getCanonicalHeaders(signed);
    const names = Object.keys(canonicalHeaders).sort();
    const canonicalHeaderBytes = names.map((name) => `${name}:${canonicalHeaders[name]}`).join("\n");
    const canonicalQuery = getCanonicalQuery(signed);
    const payloadHash = await getPayloadHash(signed, Sha256);
    if (payloadHash !== actualBodyHash) throw new Error("Signer did not hash the complete supplied body");
    // Fixed canonicalPath literals were reviewed against the pinned signer path
    // policy; canonical headers/query come from its public independent helpers.
    // This assembly captures the complete documented SigV4 preimage, not a call
    // to private signer methods or any candidate serializer.
    const canonical = `${signed.method}\n${vector.canonicalPath}\n${canonicalQuery}\n${canonicalHeaderBytes}\n\n${
      names.join(";")
    }\n${payloadHash}`;
    const authorization = signed.headers.authorization;
    if (
      typeof authorization !== "string" || !authorization.includes(`/${vector.region}/${vector.service}/aws4_request`)
    ) throw new Error("Unexpected signing authority");
    const signedDate = signed.headers["x-amz-date"];
    if (typeof signedDate !== "string") throw new Error("Independent signer omitted the signing date");
    const scope = `${signedDate.slice(0, 8)}/${vector.region}/${vector.service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${signed.headers["x-amz-date"]}\n${scope}\n${
      createHash("sha256").update(canonical).digest("hex")
    }`;
    // The public string-signing overload verifies that the recorded complete
    // canonical preimage actually produces the request signer's signature.
    const preimageSignature = await signer.sign(stringToSign, { signingDate: new Date(vector.signingDate) });
    if (!authorization.endsWith(`Signature=${preimageSignature}`)) {
      throw new Error("Recorded canonical preimage does not explain signed request");
    }
    const files = {
      stringToSign: `${vector.id}.string-to-sign.txt`,
      canonicalRequest: `${vector.id}.canonical-request.txt`,
      canonicalHeaders: `${vector.id}.canonical-headers.txt`,
      authorization: `${vector.id}.authorization.txt`,
      signedHeaders: `${vector.id}.signed-headers.json`,
    };
    await writeFile(resolve(output, files.stringToSign), Buffer.from(stringToSign, "utf8"), { flag: "wx" });
    await writeFile(resolve(output, files.canonicalRequest), Buffer.from(canonical, "utf8"), { flag: "wx" });
    await writeFile(resolve(output, files.canonicalHeaders), Buffer.from(canonicalHeaderBytes, "utf8"), { flag: "wx" });
    await writeFile(resolve(output, files.authorization), Buffer.from(authorization, "utf8"), { flag: "wx" });
    await writeFile(resolve(output, files.signedHeaders), JSON.stringify(signed.headers, null, 2) + "\n", {
      flag: "wx",
    });
    receipts.push({
      id: vector.id,
      service: vector.service,
      region: vector.region,
      signingDate: vector.signingDate,
      purpose: vector.purpose ?? "Glacier request signing mechanics; no native service acceptance",
      request: { ...request, body: { originalFile: original.file, bytes: original.size, sha256: actualBodyHash } },
      canonicalPath: vector.canonicalPath,
      canonicalQuery,
      payloadHash,
      canonicalRequest: canonical,
      stringToSign,
      signedHeaders: signed.headers,
      authorization,
      files,
    });
  }
  await writeFile(
    resolve(output, "signatures.json"),
    JSON.stringify(
      { authority: "pinned public Smithy signer; complete original request bodies retained separately", receipts },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
} finally {
  clearCredentialCache();
}
