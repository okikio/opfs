/** Compile-only installed archive preservation contracts; never execute these expressions. */
import { openBagit } from "@okikio/opfs/archive/bagit";
import { openOcfl } from "@okikio/opfs/archive/ocfl";

const bag = await openBagit([]);
const bagProof: "supplied-inventory" = bag.coverage.scope;
const ocfl = await openOcfl([]);
const ocflProof: "supplied-object-files" = ocfl.coverage.scope;
void ocflProof;
void bagProof;
