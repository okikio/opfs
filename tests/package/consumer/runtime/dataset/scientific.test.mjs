/** Installed dataset scientific contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openFits } from "@okikio/opfs/dataset/fits";
import { openNetcdf } from "@okikio/opfs/dataset/netcdf";
import { createZarrLedger, openZarr } from "@okikio/opfs/dataset/zarr";
import { openHdf5 } from "@okikio/opfs/dataset/hdf5";
import { assertBytes } from "../../bytes.mjs";
import hdf5Input from "../../data/dataset/hdf5.json" with { type: "json" };
import netcdfInput from "../../data/dataset/netcdf.json" with { type: "json" };
import zarrInput from "../../data/dataset/zarr.json" with { type: "json" };
import fitsInput from "../../data/dataset/fits.json" with { type: "json" };

describe("packed dataset scientific", () => {
  it("HDF5 links and numeric values", async () => {
    const hdf5Fixture = hdf5Input;
    const hdf5 = await openHdf5(
      createByteSource(Uint8Array.from(atob(hdf5Fixture.wire), (byte) => byte.charCodeAt(0))),
      { profile: "classic-contiguous" },
    );
    if (!hdf5.list().some((link) => link.name === "soft" && link.kind === "soft")) {
      throw new Error("Packed HDF5 root links changed");
    }
    for (const fixture of hdf5Fixture.datasets) {
      const dataset = await hdf5.dataset(fixture.name);
      assertBytes(
        await dataset.source().read(0, dataset.byteLength),
        Uint8Array.from(atob(fixture.original), (byte) => byte.charCodeAt(0)),
      );
      const result = await dataset.read();
      if (
        result.integrity !== "not-provided" ||
        JSON.stringify(Array.from(result.values, (value) => String(value))) !== JSON.stringify(fixture.values)
      ) throw new Error("Packed HDF5 numeric values changed");
    }
  });
  it("netCDF raw records and physical scaling", async () => {
    const netcdfFixture = netcdfInput;
    const netcdf = await openNetcdf(
      createByteSource(Uint8Array.from(atob(netcdfFixture), (byte) => byte.charCodeAt(0))),
    );
    const netcdfVariable = netcdf.variables.find((entry) => entry.name === "records");
    if (!netcdfVariable || netcdf.version !== 2 || netcdf.deviations.length) {
      throw new Error("Packed netCDF native profile changed");
    }
    const netcdfRaw = await netcdf.read(netcdfVariable.id, { offset: 2, count: 5 });
    if (
      !(netcdfRaw.values instanceof Int16Array) || JSON.stringify(Array.from(netcdfRaw.values)) !== "[2,3,-777,5,6]" ||
      JSON.stringify(Array.from(netcdfRaw.undefinedMask)) !== "[0,0,1,0,0]" || netcdfRaw.integrity !== "not-provided"
    ) throw new Error("Packed netCDF raw record selection changed");
    const netcdfPhysical = await netcdf.read(netcdfVariable.id, { offset: 2, count: 5, scale: "physical" });
    if (
      !(netcdfPhysical.values instanceof Float64Array) ||
      JSON.stringify(Array.from(netcdfPhysical.values)) !== "[11,11.5,-378.5,12.5,13]"
    ) throw new Error("Packed netCDF physical scaling changed");
  });
  it("Zarr independent objects and fill scope", async () => {
    const zarrFixtures = zarrInput;
    for (const fixture of zarrFixtures) {
      const objects = new Map(
        Object.entries(fixture.objects).map(([key, value]) => [
          key,
          Uint8Array.from(atob(value.base64), (byte) => byte.charCodeAt(0)),
        ]),
      );
      const objectLedger = createZarrLedger(1024);
      const array = await openZarr({
        stability: "immutable",
        async open(key) {
          const bytes = objects.get(key);
          return bytes ? createByteSource(bytes) : undefined;
        },
      }, { objectLedger });
      const result = await array.read();
      assertBytes(
        new Uint8Array(result.values.buffer, result.values.byteOffset, result.values.byteLength),
        Uint8Array.from(atob(fixture.original.base64), (byte) => byte.charCodeAt(0)),
      );
      if (
        result.integrity !== "not-provided" || objectLedger.inspect() < 2 ||
        (fixture.profile === "missing" && !result.fillMask.some(Boolean))
      ) throw new Error("Packed Zarr object/fill scope changed");
    }
  });
  it("FITS exact integers and padded checksums", async () => {
    const fitsFixture = fitsInput;
    const fits = await openFits(createByteSource(Uint8Array.from(atob(fitsFixture), (byte) => byte.charCodeAt(0))));
    const fitsRaw = await fits.read(1);
    if (
      !(fitsRaw.values instanceof BigInt64Array) || fitsRaw.values[0] !== -9007199254740993n ||
      fitsRaw.values[1] !== 9007199254740993n || fitsRaw.values[2] !== 9223372036854775807n ||
      fitsRaw.integrity !== "pending"
    ) throw new Error("Packed FITS exact raw integer scope changed");
    const fitsVerified = await fits.verify(1);
    if (
      fitsVerified.datasum !== "verified" || fitsVerified.checksum !== "verified" ||
      fitsRaw.undefinedMask.some((value) => value !== 0)
    ) throw new Error("Packed FITS padded checksum scope changed");
  });
});
