/** Deterministic input crosses a 64 KiB authenticated segment. */
export const bytes = Uint8Array.from({ length: 65537 }, (_, index) => index % 251);

/** Compare exact original bytes without deriving an oracle from candidate output. */
export const assertBytes = (actual, expected) => {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error("Packed consumer bytes differ");
  }
};

/** Bounded archive payload shared by the installed streaming contracts. */
export const archivePayload = bytes.slice(0, 1024);

/** Decode retained producer bytes without importing candidate codecs. */
export const fromBase64 = (value) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
