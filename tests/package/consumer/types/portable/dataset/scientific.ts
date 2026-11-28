/** Compile-only installed dataset scientific contracts; never execute these expressions. */
import { openFits } from "@okikio/opfs/dataset/fits";
import { openNetcdf } from "@okikio/opfs/dataset/netcdf";
import { createZarrLedger, openZarr } from "@okikio/opfs/dataset/zarr";
import { openHdf5 } from "@okikio/opfs/dataset/hdf5";
import { createByteSource } from "@okikio/opfs/source";

const fits: import("@okikio/opfs/dataset/fits").FitsDatasetType = await openFits(createByteSource(new Uint8Array()));
const fitsValues: import("@okikio/opfs/dataset/fits").FitsValuesType = (await fits.read(0)).values;
const fitsVerification: import("@okikio/opfs/dataset/fits").FitsVerificationType = await fits.verify(0);
const netcdf: import("@okikio/opfs/dataset/netcdf").NetcdfDatasetType = await openNetcdf(
  createByteSource(new Uint8Array()),
  { recordVsize: "validate" },
);
const netcdfRead: import("@okikio/opfs/dataset/netcdf").NetcdfReadType = await netcdf.read(0, {
  missing: "attributes",
  scale: "physical",
});
const zarrStore: import("@okikio/opfs/dataset/zarr").ZarrStoreType = {
  stability: "caller",
  async open() {
    return undefined;
  },
};
const zarr: import("@okikio/opfs/dataset/zarr").ZarrArrayType = await openZarr(zarrStore, {
  objectLedger: createZarrLedger(),
});
const zarrRead: import("@okikio/opfs/dataset/zarr").ZarrReadType = await zarr.read({ offset: 0, count: 0 });
const hdf5Typed: import("@okikio/opfs/dataset/hdf5").Hdf5FileType = await openHdf5(createByteSource(new Uint8Array()), {
  profile: "classic-contiguous",
});
const hdf5Dataset: import("@okikio/opfs/dataset/hdf5").Hdf5DatasetType = await hdf5Typed.dataset("literal-name");
const hdf5Values: import("@okikio/opfs/dataset/hdf5").Hdf5ValuesType =
  (await hdf5Dataset.read({ offset: 0, count: 1 })).values;
void hdf5Values;
void zarrRead;
void fitsValues;
void fitsVerification;
void netcdfRead;
