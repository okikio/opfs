/** Compile-only installed messaging kafka contracts; never execute these expressions. */
import {
  createKafkaClient,
  KafkaClient,
  KafkaCompletionError,
  KafkaError,
  KafkaOutcomeError,
} from "@okikio/opfs/kafka";

const kafkaOptionsTyped: import("@okikio/opfs/kafka").KafkaOptionsType = {
  topic: "owned",
  partition: 0,
  brokerId: 1,
  openChannel: async (): Promise<import("@okikio/opfs/kafka").KafkaChannelType> => {
    throw new Error("type-only");
  },
};
const kafkaTyped: KafkaClient = createKafkaClient(kafkaOptionsTyped);
const kafkaRecordTyped: import("@okikio/opfs/kafka").KafkaRecordType = {
  timestamp: 1700000000000n,
  key: null,
  value: new Uint8Array(),
  headers: [],
};
const kafkaReceiptTyped: import("@okikio/opfs/kafka").KafkaReceiptType = await kafkaTyped.append([kafkaRecordTyped]);
const kafkaPageTyped: import("@okikio/opfs/kafka").KafkaPageType = await kafkaTyped.fetch(kafkaReceiptTyped.baseOffset);
const kafkaMetadataTyped: import("@okikio/opfs/kafka").KafkaMetadataType = await kafkaTyped.metadata();
const kafkaOffsetTyped: import("@okikio/opfs/kafka").KafkaOffsetType = await kafkaTyped.offset("latest");
const kafkaFetchedTyped: import("@okikio/opfs/kafka").KafkaFetchedRecordType | undefined = kafkaPageTyped.records[0];
const kafkaHeaderTyped: import("@okikio/opfs/kafka").KafkaHeaderType = { name: "dup", value: null };
const kafkaErrorsTyped: readonly Error[] = [
  new KafkaError("append", 20),
  new KafkaOutcomeError(new Error("type-only")),
  new KafkaCompletionError(kafkaReceiptTyped, new Error("type-only")),
];
void kafkaMetadataTyped;
void kafkaOffsetTyped;
void kafkaFetchedTyped;
void kafkaHeaderTyped;
void kafkaErrorsTyped;
