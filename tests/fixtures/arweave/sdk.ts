/** Structural boundaries for the test-only pinned ArweaveJS 1.15.7 calls.
 * Runtime SDK modules stay outside production and outside static imports.
 */
export type TagType = { name: string; value: string };
export type SignedType = Record<string, unknown> & { id: string; data: string };
export type WalletType = { kty: string; e: string; n: string; [key: string]: string };
export type TransactionType = {
  id: string;
  signature: string;
  data_root: string;
  tags: unknown[];
  chunks?: {
    chunks: { dataHash: Uint8Array; minByteRange: number; maxByteRange: number }[];
    proofs: { offset: number; proof: Uint8Array }[];
  };
  addTag(name: string, value: string): void;
  getSignatureData(): Promise<Uint8Array>;
  toJSON(): SignedType;
};
export type ArweaveType = {
  api: {
    get: (...args: unknown[]) => unknown;
    post: (...args: unknown[]) => unknown;
    request: (...args: unknown[]) => unknown;
  };
  wallets: { generate(): Promise<WalletType>; jwkToAddress(wallet: WalletType): Promise<string> };
  createTransaction(
    input: { data: Uint8Array; last_tx: string; reward: string; quantity: string },
    wallet: WalletType,
  ): Promise<TransactionType>;
  transactions: {
    sign(transaction: TransactionType, wallet: WalletType, options?: { saltLength: number }): Promise<void>;
    verify(transaction: TransactionType): Promise<boolean>;
  };
};
export type FactoryType = { init(options: { host: string; port: number; protocol: string }): ArweaveType };
