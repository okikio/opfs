/** Compile-only installed dataset geometry contracts; never execute these expressions. */
import { openLas } from "@okikio/opfs/dataset/las";
import { openShapefile } from "@okikio/opfs/dataset/shapefile";
import { openGeotiff } from "@okikio/opfs/dataset/geotiff";
import { createByteSource } from "@okikio/opfs/source";

const las: import("@okikio/opfs/dataset/las").LasDatasetType = await openLas(createByteSource(new Uint8Array()));
const lasRead: import("@okikio/opfs/dataset/las").LasReadType = await las.read({ scale: "physical" });
const shapefileTyped: import("@okikio/opfs/dataset/shapefile").ShapefileType = await openShapefile({
  shp: createByteSource(new Uint8Array()),
}, { profile: "shp2d-dbf3" });
const shapefileReadTyped: import("@okikio/opfs/dataset/shapefile").ShapefileReadType = await shapefileTyped.read(0);
const geotiffOptionsTyped: import("@okikio/opfs/dataset/geotiff").GeotiffOpenOptionsType = {
  profile: "classic-geotiff-raw",
  maxWindowBytes: 1024,
};
const geotiffTyped: import("@okikio/opfs/dataset/geotiff").GeotiffType = await openGeotiff(
  createByteSource(new Uint8Array()),
  geotiffOptionsTyped,
);
const geotiffWindowTyped: import("@okikio/opfs/dataset/geotiff").GeotiffWindowType = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};
const geotiffPlanTyped: import("@okikio/opfs/dataset/geotiff").GeotiffPlanType = geotiffTyped.plan(
  0,
  geotiffWindowTyped,
);
const geotiffReadTyped: import("@okikio/opfs/dataset/geotiff").GeotiffReadType = await geotiffTyped.read(
  0,
  geotiffWindowTyped,
  { maxOutputBytes: 1024 },
);
const geotiffValuesTyped: import("@okikio/opfs/dataset/geotiff").GeotiffValuesType = geotiffReadTyped.values;
const geotiffCogTyped: "not-evaluated" = geotiffTyped.cog;
const geotiffIntegrityTyped: "not-provided" = geotiffReadTyped.integrity;
const geotiffImageTyped: import("@okikio/opfs/dataset/geotiff").GeotiffImageType | undefined = geotiffTyped.images[0];
const geotiffGeoTyped: import("@okikio/opfs/dataset/geotiff").GeotiffGeoType | undefined = geotiffImageTyped?.geo;
const geotiffSourceTyped: import("@okikio/opfs/source").ByteSourceType = geotiffTyped.source(0, 0);
void geotiffPlanTyped;
void geotiffValuesTyped;
void geotiffCogTyped;
void geotiffIntegrityTyped;
void geotiffImageTyped;
void geotiffGeoTyped;
void geotiffSourceTyped;
void shapefileReadTyped;
void lasRead;
