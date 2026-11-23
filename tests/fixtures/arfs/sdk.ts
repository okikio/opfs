/** The narrow test-only ArDrive 5.1.1 surface used by this fixture producer. */
import type { TagType } from "../arweave/sdk.ts";
export type DataType = { asTransactionData(): string };
export type PrototypeType = { gqlTags: TagType[] };
export type NodeType = {
  id: string;
  owner: { address: string };
  tags: TagType[];
  block: { height: number; timestamp: number };
};
export type BuilderType = {
  fromArweaveNode(node: NodeType, gateway: { getTxData(id: unknown): Promise<Uint8Array> }): {
    build(node: NodeType): Promise<{ name: string; size?: unknown; dataTxId?: unknown; lastModifiedDate?: unknown }>;
  };
};
export type SDKType = {
  EntityID: new (value: string) => unknown;
  ByteCount: new (value: number) => unknown;
  UnixTime: new (value: number) => unknown;
  TransactionID: new (value: string) => unknown;
  ArweaveAddress: new (value: string) => unknown;
  ArFSPublicDriveTransactionData: new (...args: unknown[]) => DataType;
  ArFSPublicFolderTransactionData: new (...args: unknown[]) => DataType;
  ArFSPublicFileMetadataTransactionData: new (...args: unknown[]) => DataType;
  ArFSPublicFilePinMetadataTransactionData: new (...args: unknown[]) => DataType;
  ArFSPublicDriveMetaDataPrototype: new (...args: unknown[]) => PrototypeType;
  ArFSPublicFolderMetaDataPrototype: new (...args: unknown[]) => PrototypeType;
  ArFSPublicFileMetaDataPrototype: new (...args: unknown[]) => PrototypeType;
  ArFSPublicDriveBuilder: BuilderType;
  ArFSPublicFolderBuilder: BuilderType;
  ArFSPublicFileBuilder: BuilderType;
};
