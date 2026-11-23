/** Test-only immutable artifact identities; a wheel is a ZIP container, not an install instruction. */
export const ARROW = {
  url:
    "https://files.pythonhosted.org/packages/90/c3/0c7da7b6dac863af75b64e2f827e4742161128c350bfe7955b426484e226/pyarrow-20.0.0-cp313-cp313-manylinux_2_28_aarch64.whl",
  bytes: 40677027,
  sha256: "991f85b48a8a5e839b2128590ce07611fae48a904cae6cab1f089c5955b57eb5",
} as const;

/** Official v1.3.2 CLI replaces the historical Python binding, not its recorded bytes. */
export const DUCKDB = {
  url: "https://github.com/duckdb/duckdb/releases/download/v1.3.2/duckdb_cli-linux-arm64.zip",
  sha256: "f322807f0f5d146d2bb1eea253f894d0a015561695408fa22981f085eb2b77ad",
} as const;

export const LIBRARIES = {
  "libarrow.so.2000": "30731be58945008b5864462de64769baff13a3afc197a3d7fef8ada2856a4b98",
  "libparquet.so.2000": "97f6dd678fd3a778056f12c74f17886f718612dd7d9b9463d00fef02f66fbeb1",
} as const;
