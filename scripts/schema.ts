import { compileSchemas, type SchemaEntryType } from "./schema/compiler.ts";
import {
  AdapterCapabilitiesSchema,
  AdapterLimitsSchema,
  AdapterNameSchema,
  AdapterPartitionSchema,
  CoordinationModeSchema,
  Db0DialectSchema,
  DirectoryRecordSchema,
  DriverKindSchema,
  DriverOptimizationSchema,
  DriverOwnershipSchema,
  EntryKindSchema,
  ErrorCodeSchema,
  FileRecordSchema,
  LimitKindSchema,
  LimitSchema,
  LimitSourceSchema,
  LimitUnitSchema,
  MetricsModeSchema,
  OpfsContextSchema,
  OptimizationSchema,
  PartitionModeSchema,
  PathSchema,
  RecordSchema,
  RecordVersionSchema,
  RequirementSchema,
  RequirementStateSchema,
  SqlIdentifierSchema,
  SupportModeSchema,
  WriteModeSchema,
} from "../src/schema.ts";
import { FileDriverCapabilitiesSchema } from "../src/driver/file.ts";
import { RecordDriverCapabilitiesSchema, RecordReplacementSchema } from "../src/driver/record.ts";
import { ObjectDriverCapabilitiesSchema } from "../src/driver/object.ts";
import { RequestPolicySchema } from "../src/request.ts";
import { IntegrationDirectionSchema, IntegrationDirectionsSchema } from "../src/integration/definition.ts";
import { S3AddressingSchema, S3CredentialsSchema } from "../src/s3.ts";
import { AzureStorageVersionSchema } from "../src/azure.ts";

const entries = [
  [PathSchema, "PathType"],
  [AdapterNameSchema, "AdapterNameType"],
  [EntryKindSchema, "EntryKindType"],
  [OpfsContextSchema, "OpfsContextType"],
  [CoordinationModeSchema, "CoordinationModeType"],
  [WriteModeSchema, "WriteModeType"],
  [SupportModeSchema, "SupportModeType"],
  [MetricsModeSchema, "MetricsModeType"],
  [PartitionModeSchema, "PartitionModeType"],
  [AdapterPartitionSchema, "AdapterPartitionType"],
  [AdapterLimitsSchema, "AdapterLimitsType"],
  [OptimizationSchema, "OptimizationType"],
  [AdapterCapabilitiesSchema, "AdapterCapabilitiesType"],
  [ErrorCodeSchema, "ErrorCodeType"],
  [RecordVersionSchema, "RecordVersionType"],
  [DirectoryRecordSchema, "DirectoryRecordType"],
  [FileRecordSchema, "FileRecordType"],
  [RecordSchema, "RecordType"],
  [Db0DialectSchema, "Db0DialectType"],
  [SqlIdentifierSchema, "SqlIdentifierType"],
  [DriverKindSchema, "DriverKindType"],
  [LimitKindSchema, "LimitKindType"],
  [LimitSourceSchema, "LimitSourceType"],
  [LimitUnitSchema, "LimitUnitType"],
  [LimitSchema, "LimitType"],
  [RequirementStateSchema, "RequirementStateType"],
  [RequirementSchema, "RequirementType"],
  [DriverOwnershipSchema, "DriverOwnershipType"],
  [DriverOptimizationSchema, "DriverOptimizationType"],
  [FileDriverCapabilitiesSchema, "FileDriverCapabilitiesType"],
  [RecordReplacementSchema, "RecordReplacementType"],
  [RecordDriverCapabilitiesSchema, "RecordDriverCapabilitiesType"],
  [ObjectDriverCapabilitiesSchema, "ObjectDriverCapabilitiesType"],
  [RequestPolicySchema, "RequestPolicyType"],
  [IntegrationDirectionSchema, "IntegrationDirectionType"],
  [IntegrationDirectionsSchema, "IntegrationDirectionsType"],
  [S3AddressingSchema, "S3AddressingType"],
  [S3CredentialsSchema, "S3CredentialsType"],
  [AzureStorageVersionSchema, "AzureStorageVersionType"],
] as const satisfies readonly (readonly [SchemaEntryType["schema"], string])[];

const content = compileSchemas(entries.map(([schema, name]) => ({ schema, name })));
const target = new URL("../src/_schema_types.ts", import.meta.url);
const check = Deno.args.includes("--check");

if (check) {
  let current = "";
  try {
    current = await Deno.readTextFile(target);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (current !== content) {
    console.error("src/_schema_types.ts is stale. Run `deno task schema`.");
    Deno.exit(1);
  }
} else {
  await Deno.writeTextFile(target, content);
}
