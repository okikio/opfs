/** Compile-only installed provider records contracts; never execute these expressions. */
import { createCmisClient } from "@okikio/opfs/cmis";
import { createCouchdbClient } from "@okikio/opfs/couchdb";
import { createEtcdClient } from "@okikio/opfs/etcd";

const cmisTyped: import("@okikio/opfs/cmis").CmisClient = createCmisClient({
  repository: "type-only",
  repositoryUrl: "https://repository.example/browser/A1",
  rootUrl: "https://repository.example/browser/A1/root",
});
const cmisPage: import("@okikio/opfs/cmis").CmisPageType = await cmisTyped.list("root", { limit: 1 });
const couchdbTyped: import("@okikio/opfs/couchdb").CouchdbClient = createCouchdbClient({
  endpoint: "https://couchdb.example/",
  database: "type-only",
});
const couchdbDocument: import("@okikio/opfs/couchdb").CouchdbDocumentType = await couchdbTyped.document("doc");
const couchdbReceipt: import("@okikio/opfs/couchdb").CouchdbReceiptType = await couchdbTyped.put(
  "doc",
  "file",
  new Uint8Array(),
  { revision: couchdbDocument.revision },
);
const etcdTyped: import("@okikio/opfs/etcd").EtcdClient = createEtcdClient({ endpoint: "https://etcd.example/" });
const etcdGet: import("@okikio/opfs/etcd").EtcdGetType = await etcdTyped.get(new Uint8Array([1]));
const etcdReceipt: import("@okikio/opfs/etcd").EtcdReceiptType = await etcdTyped.put(
  new Uint8Array([1]),
  new Uint8Array(),
  { modRevision: "1", lease: "preserve" },
);
void cmisPage;
void couchdbReceipt;
void etcdGet;
void etcdReceipt;
