/** Project retained dataset oracles into the disposable installed consumer. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Preserve producer selections and original JSON text where numeric lexemes are evidence. */
export async function datasetFixtures(): Promise<Record<string, unknown>> {
  // Admit the frozen native corpus before copying its values into the installed consumer.
  const arrowCorpusBytes = await readFile(
    fileURLToPath(new URL("../../fixtures/ipc/native/independent.json", import.meta.url).href),
  );
  if (
    arrowCorpusBytes.length !== 106854 || createHash("sha256").update(arrowCorpusBytes).digest("hex") !==
      "09bac9152ccc959f35274cd8f47f3fa170517e6dd0823ea530532b73031d44d1"
  ) {
    throw new Error("Frozen Arrow IPC package-consumer corpus differs from its admitted bytes.");
  }
  const arrowCorpus: unknown = JSON.parse(arrowCorpusBytes.toString("utf8"));
  const bamCorpusBytes = await readFile(new URL("../../fixtures/bam/native/corpus.json", import.meta.url));
  if (
    bamCorpusBytes.length !== 325349 ||
    createHash("sha256").update(bamCorpusBytes).digest("hex") !==
      "4b18297001bdc669a16801340dcb7e5847c073a5aa577cd6baf0c59de5297ebf"
  ) {
    throw new Error("Frozen BAM package-consumer corpus differs from its admitted bytes.");
  }
  const bamCorpus: unknown = JSON.parse(bamCorpusBytes.toString("utf8"));

  return {
    "dataset/shapefile.json": await readFile(
      new URL("../../fixtures/shapefile/independent.json", import.meta.url),
      "utf8",
    ),
    "dataset/geotiff.json": await readFile(new URL("../../fixtures/geotiff/independent.json", import.meta.url), "utf8"),
    "dataset/bam.json": bamCorpus,
    "dataset/arrow.json": arrowCorpus,
    "dataset/orc.json": JSON.parse(
      await readFile(new URL("../../fixtures/orc/independent.json", import.meta.url), "utf8"),
    ),
    "dataset/parquet.json": JSON.parse(
      await readFile(new URL("../../fixtures/parquet/independent.json", import.meta.url), "utf8"),
    ),
    "dataset/mcap.json": JSON.parse(
      await readFile(new URL("../../fixtures/mcap/independent.json", import.meta.url), "utf8"),
    ).fixtures.find(
      (row: Record<string, unknown>) => row.name === "chunked",
    ),
    "dataset/hdf5.json": await (async () => {
      const fixture =
        JSON.parse(await readFile(new URL("../../fixtures/hdf5/independent.json", import.meta.url), "utf8")).files[0];
      return {
        wire: fixture.bytesBase64,
        datasets: fixture.datasets.filter((
          row: { name: string; originalBase64: string; values: { integer: unknown }[] },
        ) => ["i64_be", "grid", "empty"].includes(row.name)).map((
          row: { name: string; originalBase64: string; values: { integer: unknown }[] },
        ) => ({
          name: row.name,
          original: row.originalBase64,
          values: row.values.map((value: { integer: unknown }) => value.integer),
        })),
      };
    })(),
    "dataset/netcdf.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/netcdf/independent.json", import.meta.url), "utf8"),
      );
      return fixture.fixtures.find((entry: Record<string, unknown>) =>
        entry.producer === "netCDF-C" && entry.profile === "mixed" && entry.version === 2
      ).file.base64;
    })(),
    "dataset/las.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/las/independent.json", import.meta.url), "utf8"),
      );
      return fixture.fixtures.find((entry: Record<string, unknown>) =>
        entry.producer === "struct" && entry.format === 3 && entry.count === 37 && entry.extra
      );
    })(),
    "dataset/zarr.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/zarr/independent.json", import.meta.url), "utf8"),
      );
      return [
        ...["C", "F"].map((order) =>
          fixture.fixtures.find((entry: Record<string, unknown>) =>
            entry.producer === "Zarr" && entry.dtype === ">i2" && entry.order === order
          )
        ),
        fixture.fixtures.find((entry: Record<string, unknown>) => entry.profile === "boolean-noncanonical"),
        fixture.fixtures.find((entry: Record<string, unknown>) => entry.profile === "missing"),
      ];
    })(),
    "dataset/fits.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/fits/independent.json", import.meta.url), "utf8"),
      );
      return fixture.fixtures.find((entry: Record<string, unknown>) => entry.producer === "cfitsio").file.base64;
    })(),
  };
}
