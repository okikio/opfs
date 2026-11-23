import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openBinHex } from "../src/archive/binhex.ts";
import { createBlobSource } from "../src/source.ts";
import { expectBytes, report } from "./result.ts";
import native from "../tests/fixtures/binhex/independent.json" with { type: "json" };

// The decoded Blob lane omits BinHex parsing, replay and CRC. It is a lower
// bound for copying selected bytes, not an equivalent verified-preview contract.
const fixture = native.fixtures.find((value) => value.case === "many" && value.producer === "macutils");
if (!fixture) throw new Error("BinHex native benchmark original is missing.");
const data = decodeBase64(fixture.data.base64), resource = decodeBase64(fixture.resource.base64);
const wire = decodeBase64(fixture.archive.base64);
const source = createBlobSource(new Blob([new Uint8Array(wire).buffer]));
const decoded = createBlobSource(new Blob([new Uint8Array(data).buffer]));
// Warm sampling spans one finite lifetime owner. These are benchmark allowances,
// not production defaults; individual reads keep their separate default caps.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 4 * 1024 ** 3,
  maxRequests: 10_000_000,
};
const archive = await openBinHex(source, { ...allowance, preamble: "rfc1741-or-macutils" });
const offset = 17, length = 37;
const selected = data.slice(offset, offset + length), selectedResource = resource.slice(offset, offset + length);
expectBytes((await archive.read("data")).bytes, data, "binhex/native-data-full");
expectBytes((await archive.read("resource")).bytes, resource, "binhex/native-resource-full");
expectBytes(await decoded.read(offset, length), selected, "binhex/native-decoded-Blob-range");
const prefix = await archive.read("data", { offset, length });
const partial = await archive.read("data", { offset, length, verify: false });
const resourcePrefix = await archive.read("resource", { offset, length });
expectBytes(prefix.bytes, selected, "binhex/verified-data-prefix");
expectBytes(partial.bytes, selected, "binhex/pending-data-prefix");
expectBytes(resourcePrefix.bytes, selectedResource, "binhex/verified-resource-prefix");
const verified = await archive.verify();
if (prefix.data !== "crc16-verified" || partial.data !== "pending" || resourcePrefix.terminal !== "verified") {
  throw new Error("BinHex benchmark evidence scope differs.");
}
// This check visits every streamed byte before timing; timed drains retain only
// a byte count. The source and destination are borrowed and have no close owner.
const streamed = archive.stream("data");
let cursor = 0;
for await (const bytes of streamed.stream) {
  expectBytes(bytes, data.subarray(cursor, cursor + bytes.length), "binhex/native-streamed-full");
  cursor += bytes.length;
}
const streaming = await streamed.finished;
if (cursor !== data.length || streaming.data !== "crc16-verified") {
  throw new Error("BinHex full-stream oracle differs.");
}
bench(
  `binhex cold header archive=${wire.length}B source=${archive.work.sourceBytes}B decoded=${archive.work.decodedBytes}B requests=${archive.work.requests} header-CRC16`,
  async () => do_not_optimize(await openBinHex(source, { preamble: "rfc1741-or-macutils" })),
);
bench("binhex native decoded Blob range source=37B output=37B requests=1 no-encoding-no-CRC", async () => {
  do_not_optimize(await decoded.read(offset, length));
});
bench(
  `binhex warm verified data prefix source=${prefix.work.sourceBytes}B decoded=${prefix.work.decodedBytes}B output=37B requests=${prefix.work.requests} data-CRC16-resource-pending`,
  async () => do_not_optimize(await archive.read("data", { offset, length })),
);
bench(
  `binhex warm pending data prefix source=${partial.work.sourceBytes}B decoded=${partial.work.decodedBytes}B output=37B requests=${partial.work.requests} header-CRC16-data-pending`,
  async () => do_not_optimize(await archive.read("data", { offset, length, verify: false })),
);
bench(
  `binhex warm resource prefix source=${resourcePrefix.work.sourceBytes}B decoded=${resourcePrefix.work.decodedBytes}B output=37B requests=${resourcePrefix.work.requests} both-forks-CRC16-terminal`,
  async () => do_not_optimize(await archive.read("resource", { offset, length })),
);
bench(
  `binhex warm full verify source=${verified.work.sourceBytes}B decoded=${verified.work.decodedBytes}B output=0B requests=${verified.work.requests} both-forks-CRC16-terminal`,
  async () => do_not_optimize(await archive.verify()),
);
bench(
  `binhex warm data stream source=${streaming.work.sourceBytes}B decoded=${streaming.work.decodedBytes}B output=${data.length}B requests=${streaming.work.requests} data-CRC16-resource-pending`,
  async () => {
    const output = archive.stream("data");
    let bytes = 0;
    for await (const chunk of output.stream) bytes += chunk.length;
    do_not_optimize(bytes);
    do_not_optimize(await output.finished);
  },
);
await report();
