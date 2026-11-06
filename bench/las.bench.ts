import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openLas } from "../src/dataset/las.ts";
import type { LasReadType } from "../src/dataset/las.ts";
import { expectBytes, report } from "./result.ts";
import fixture from "../tests/fixtures/las/independent.json" with { type: "json" };

const item = fixture.fixtures.find((item) => item.producer === "laspy" && item.format === 3 && item.count === 12000)!;
const bytes = decodeBase64(item.file.base64),
  blob = new Blob([new Uint8Array(bytes).buffer]),
  source = createBlobSource(blob);
const repeated = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
  maxRequests: 100000000,
};
const dataset = await openLas(source, repeated), whole = await dataset.read({ scale: "physical" });
/** Preflight every returned column using native originals, outside sampling. */
function preflight(result: LasReadType, offset: number, count: number): void {
  for (
    const [key, field] of [
      ["X", "X"],
      ["Y", "Y"],
      ["Z", "Z"],
      ["intensity", "intensity"],
      ["return_number", "returnNumber"],
      ["number_of_returns", "returnCount"],
      ["scan_direction_flag", "scanDirection"],
      ["edge_of_flight_line", "edgeOfFlightLine"],
      ["classification", "classification"],
      ["scan_angle_rank", "scanAngleRank"],
      ["user_data", "userData"],
      ["point_source_id", "sourceId"],
      ["gps_time", "gpsTime"],
      ["red", "red"],
      ["green", "green"],
      ["blue", "blue"],
    ] as const
  ) {
    const values = result[field]!;
    const column = item.columns[key];
    if (!column) throw new Error(`LAS original fixture column is missing: ${key}`);
    const expected = decodeBase64(column.base64), width = expected.length / dataset.points;
    expectBytes(
      new Uint8Array(values.buffer),
      expected.subarray(offset * width, (offset + count) * width),
      `las/${key}/original`,
    );
  }
  const synthetic = decodeBase64(item.columns.synthetic.base64),
    keyPoint = decodeBase64(item.columns.key_point.base64),
    withheld = decodeBase64(item.columns.withheld.base64),
    classification = decodeBase64(item.columns.classification.base64),
    scan = decodeBase64(item.columns.scan_angle_rank.base64);
  const flags = Uint8Array.from(
    { length: count },
    (_, i) => synthetic[offset + i]! | keyPoint[offset + i]! << 1 | withheld[offset + i]! << 2,
  );
  expectBytes(result.classificationFlags, flags, "las/classification-flags/original");
  expectBytes(
    result.classificationByte,
    Uint8Array.from(flags, (flag, i) => classification[offset + i]! | flag << 5),
    "las/classification-byte/original",
  );
  expectBytes(result.scanAngleByte, scan.subarray(offset, offset + count), "las/scan-byte/original");
  expectBytes(result.extra, new Uint8Array(), "las/no-record-suffix/original");
  if (result.physical) {
    for (
      const [key, values] of [["x", result.physical.x], ["y", result.physical.y], ["z", result.physical.z]] as const
    ) {
      const expected = decodeBase64(item.columns[key].base64);
      expectBytes(
        new Uint8Array(values.buffer),
        expected.subarray(offset * 8, (offset + count) * 8),
        `las/${key}/physical-original`,
      );
    }
  }
}
preflight(whole, 0, dataset.points);
const context = `LAS1.2 format=3 file=${bytes.length}B points=${dataset.points} record=${dataset.recordBytes}B`;
const cold = await openLas(source);
bench(
  `${context} cold index source=${cold.work.sourceBytes}B requests=${cold.work.requests} output=0B`,
  async () => do_not_optimize(await openLas(source)),
);
for (const [offset, count] of [[3, 7], [0, dataset.points]] as const) {
  for (const scale of ["raw", "physical"] as const) {
    const selected = await dataset.read({ offset, count, scale });
    preflight(selected, offset, count);
    const label =
      `${context} offset=${offset} count=${count} mode=${scale} source=${selected.work.sourceBytes}B requests=${selected.work.requests} output=${selected.work.outputBytes}B integrity=not-provided`;
    bench(`${label} warm columns`, async () => do_not_optimize(await dataset.read({ offset, count, scale })));
    if (count === 7) {
      bench(
        `${label} cold index+columns`,
        async () => do_not_optimize(await (await openLas(source)).read({ offset, count, scale })),
      );
    }
  }
  // The native baseline copies opaque wire records; it does not decode or scale columns.
  const start = dataset.pointOffset + offset * dataset.recordBytes, length = count * dataset.recordBytes;
  const native = () => blob.slice(start, start + length).arrayBuffer();
  expectBytes(
    new Uint8Array(await native()),
    decodeBase64(item.records.base64).subarray(offset * dataset.recordBytes, (offset + count) * dataset.recordBytes),
    "las/native-record-bytecopy/preflight",
  );
  bench(
    `${context} native preindexed record bytecopy count=${count} source=${length}B requests=1 output=${length}B`,
    async () => do_not_optimize(await native()),
  );
}
await report();
