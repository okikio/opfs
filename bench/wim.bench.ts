import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openWim } from "../src/archive/wim.ts";
import type { WimReadType } from "../src/archive/wim.ts";
import { expectBytes, report } from "./result.ts";
import storedFixture from "../tests/fixtures/wim/independent.json" with { type: "json" };
import xpressFixture from "../tests/fixtures/wim/xpress-independent.json" with { type: "json" };

// Question: what does a cold selected-image index cost, and how much work does complete
// resource verification require compared with pending early/late logical byte ranges?
// Fixtures/base64/Blobs and every complete original-byte oracle check are outside timing.
const subtle = crypto.subtle;
const xpressSource = createBlobSource(new Blob([new Uint8Array(decodeBase64(xpressFixture.base64)).buffer]));
const storedSource = createBlobSource(new Blob([new Uint8Array(decodeBase64(storedFixture.base64)).buffer]));
const sources = [storedSource, xpressSource];
const fixtures = [storedFixture, xpressFixture];
for (let index = 0; index < sources.length; index++) {
  const source = sources[index]!, fixture = fixtures[index]!;
  const archive = await openWim(source, { subtle });
  for (const expected of fixture.images) {
    const image = await archive.image(expected.index);
    for (const file of expected.files) {
      const entry = image.entries.find((entry) => entry.path === file.path)!;
      expectBytes(
        (await image.read(entry.id)).bytes,
        decodeBase64(file.base64),
        `wim/cold-index/${file.path}/original`,
      );
    }
  }
  const image = await archive.image(1);
  const work = {
    source: archive.work.sourceBytes + image.work.sourceBytes,
    requests: archive.work.requests + image.work.requests,
    decoded: archive.work.decodedBytes + image.work.decodedBytes,
    output: archive.work.outputBytes + image.work.outputBytes,
  };
  bench(
    `wim/${archive.profile} cold-selected-image-index entries=${image.entries.length} source=${work.source}B requests=${work.requests} decoded=${work.decoded}B output=${work.output}B xpressSteps=${image.xpressSteps} hash=${image.metadataIntegrity}`,
    async () => {
      // Each sample owns a fresh finite default lifetime; it includes opening and metadata verification.
      const archive = await openWim(source, { subtle });
      do_not_optimize(await archive.image(1));
    },
  );
}

// Warm samples deliberately reuse an immutable borrowed source/index. Sampling has an explicit
// finite 64 GiB/10M-request lifetime allowance; per-read defaults and decoder limits are unchanged.
const allowance = 64 * 1024 ** 3;
const archive = await openWim(xpressSource, {
  subtle,
  maxSourceBytes: allowance,
  maxRequests: 10000000,
  maxDecodedBytes: allowance,
  maxOutputBytes: allowance,
});
for (const name of ["random.bin", "long.bin"]) {
  const original = xpressFixture.images[0]!.files.find((file) => file.path === name)!;
  const expected = decodeBase64(original.base64);
  const resource = archive.resources.find((resource) => resource.sha1 === original.sha1)!;
  const complete = await archive.read(resource.id);
  expectBytes(complete.bytes, expected, `wim/${name}/complete-original`);
  const plain = new Blob([new Uint8Array(expected).buffer]);
  expectBytes(new Uint8Array(await plain.arrayBuffer()), expected, `wim/${name}/decoded-Blob-original`);
  for (const mode of ["complete", "early", "late"] as const) {
    const offset = mode === "late" ? expected.length - 48 : 0;
    const length = mode === "complete" ? expected.length : 32;
    const options = { offset, length, verify: mode === "complete" };
    const preflight: WimReadType = await archive.read(resource.id, options);
    expectBytes(preflight.bytes, expected.subarray(offset, offset + length), `wim/${name}/${mode}/original`);
    const label = `wim/${resource.compression} ${mode} original=${expected.length}B selected=${offset}+${length}`;
    bench(
      `${label} decoded-Blob-copy lower-bound source=${length}B decoded=0B output=${length}B hash=none`,
      async () => do_not_optimize(await plain.slice(offset, offset + length).arrayBuffer()),
    );
    bench(
      `${label} source=${preflight.work.sourceBytes}B requests=${preflight.work.requests} decoded=${preflight.work.decodedBytes}B output=${preflight.work.outputBytes}B xpressSteps=${preflight.xpressSteps} hash=${preflight.integrity}`,
      async () => do_not_optimize(await archive.read(resource.id, options)),
    );
  }
}

await report();
