/** Compile-only installed provider netlify contracts; never execute these expressions. */
import {
  createNetlifyClient,
  NETLIFY_PROFILE,
  NetlifyClient,
  NetlifyCompletionError,
  NetlifyError,
  NetlifyPublicationError,
} from "@okikio/opfs/netlify";

const netlifyOptionsTyped: import("@okikio/opfs/netlify").NetlifyOptionsType = {
  profile: NETLIFY_PROFILE,
  api: "https://netlify-api.example",
  site: "site",
  store: "store",
  token: "type-only",
  fetch: async () => {
    throw new Error("type-only");
  },
  authorizeDataURL: (_url, request: Readonly<import("@okikio/opfs/netlify").NetlifyDataType>) =>
    request.method === "GET",
};
const netlifyTyped: NetlifyClient = createNetlifyClient(netlifyOptionsTyped);
const netlifyOperationTyped: import("@okikio/opfs/netlify").NetlifyOperationType = {
  signal: new AbortController().signal,
};
const netlifyGetOptionsTyped: import("@okikio/opfs/netlify").NetlifyGetOptionsType = {
  ...netlifyOperationTyped,
  etag: '"cache"',
};
const netlifyHeadTyped: import("@okikio/opfs/netlify").NetlifyHeadType = await netlifyTyped.head(
  "key",
  netlifyOperationTyped,
);
const netlifyGetTyped: import("@okikio/opfs/netlify").NetlifyGetType = await netlifyTyped.get(
  "key",
  netlifyGetOptionsTyped,
);
const netlifyListOptionsTyped: import("@okikio/opfs/netlify").NetlifyListOptionsType = {
  prefix: "prefix",
  directories: true,
  cursor: "opaque",
};
const netlifyPageTyped: import("@okikio/opfs/netlify").NetlifyPageType = await netlifyTyped.list(
  netlifyListOptionsTyped,
);
const netlifyConditionTyped: import("@okikio/opfs/netlify").NetlifyConditionType = { kind: "match", etag: '"opaque"' };
const netlifyPutOptionsTyped: import("@okikio/opfs/netlify").NetlifyPutOptionsType = {
  condition: netlifyConditionTyped,
};
const netlifyPutTyped: import("@okikio/opfs/netlify").NetlifyPutType = await netlifyTyped.put(
  "key",
  new Uint8Array([1]),
  netlifyPutOptionsTyped,
);
const netlifyDeleteTyped: import("@okikio/opfs/netlify").NetlifyDeleteType = await netlifyTyped.delete("key");
const netlifyReceiptTyped: import("@okikio/opfs/netlify").NetlifyReceiptType = netlifyPutTyped;
const netlifyWorkTyped: import("@okikio/opfs/netlify").NetlifyWorkType = netlifyPutTyped.work;
if (netlifyGetTyped.state === "present") {
  const observation: import("@okikio/opfs/netlify").NetlifyObservationType = netlifyGetTyped;
  const bytes: Uint8Array = netlifyGetTyped.bytes;
  void [observation.metadata, bytes];
}
const netlifyErrorsTyped: readonly Error[] = [
  new NetlifyError("http", "api", 403),
  new NetlifyPublicationError("put", "key", undefined),
  new NetlifyCompletionError(netlifyReceiptTyped, undefined),
];
// @ts-expect-error The literal compatibility profile is mandatory; arbitrary SDK versions are not admitted.
const netlifyProfileWrong: import("@okikio/opfs/netlify").NetlifyOptionsType["profile"] = "latest";
// @ts-expect-error Capability authorization must settle synchronously to literal boolean.
const netlifyApprovalWrong: import("@okikio/opfs/netlify").NetlifyOptionsType["authorizeDataURL"] = async () => true;
void netlifyHeadTyped;
void netlifyPageTyped;
void netlifyDeleteTyped;
void netlifyWorkTyped;
void netlifyErrorsTyped;
void netlifyProfileWrong;
void netlifyApprovalWrong;
