/**
 * Parquet footer and page-header decoding.
 *
 * These functions read schema elements, column chunks, row groups and page headers
 * from a compact-protocol cursor into small checked records.
 *
 * @module
 */
import { Compact } from "./compact.ts";
import { toSafeInteger } from "../../archive/budget.ts";
import { invalid, unsupported } from "../../archive/error.ts";

export interface SchemaType {
  name: string;
  physical?: number;
  typeLength?: number;
  repetition?: number;
  children?: number;
  annotated: boolean;
}

export interface ChunkType {
  physical: number;
  path: string[];
  codec: number;
  encodings: number[];
  values: number;
  uncompressed: number;
  stored: number;
  data: number;
  dictionary?: number;
  start: number;
  end: number;
}

export interface GroupType {
  rows: number;
  chunks: ChunkType[];
}

export function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw invalid(`Parquet required ${name} field is absent.`);
  return value;
}

/** Only identity integer annotations change readability; other union arms remain bounded opaque metadata. */
export function logical(cursor: Compact): { width: number; signed: boolean } | undefined {
  let count = 0;
  let result: { width: number; signed: boolean } | undefined;
  cursor.fields({
    10: (type) => {
      cursor.type(type, 12);
      let width: number | undefined, signed: boolean | undefined;
      cursor.fields({
        1: (type) => {
          cursor.type(type, 3);
          width = cursor.byte();
        },
        2: (type) => {
          signed = cursor.bool(type);
        },
      });
      const bits = required(width, "integer annotation bitWidth");
      if (![8, 16, 32, 64].includes(bits)) throw invalid("Parquet integer annotation width is invalid.");
      result = { width: bits, signed: required(signed, "integer annotation isSigned") };
    },
  }, () => {
    count++;
  });
  if (count !== 1) throw invalid("Parquet LogicalType union must contain exactly one member.");
  return result;
}

export function schema(cursor: Compact): SchemaType {
  cursor.meter.retain(128);
  let name: string | undefined, physical: number | undefined, typeLength: number | undefined;
  let repetition: number | undefined, children: number | undefined;
  let annotated = false, hasLogical = false;
  let converted: number | undefined, integerType: { width: number; signed: boolean } | undefined;
  cursor.fields({
    1: (t) => {
      physical = cursor.number(t);
    },
    2: (t) => {
      typeLength = cursor.number(t);
    },
    3: (t) => {
      repetition = cursor.number(t);
    },
    4: (t) => {
      name = cursor.text(t);
    },
    5: (t) => {
      children = cursor.number(t);
    },
    6: (t) => {
      converted = cursor.number(t);
    },
    7: (t) => {
      cursor.type(t, 5);
      cursor.signed(32);
      annotated = true;
    },
    8: (t) => {
      cursor.number(t);
      annotated = true;
    },
    9: (t) => {
      cursor.type(t, 5);
      cursor.signed(32);
    },
    10: (t) => {
      cursor.type(t, 12);
      hasLogical = true;
      integerType = logical(cursor);
    },
  });
  const legacyInteger = converted !== undefined && converted >= 11 && converted <= 18
    ? { width: [8, 16, 32, 64][(converted - 11) % 4]!, signed: converted >= 15 }
    : undefined;
  const legacyWidth = converted === 17 ? 32 : converted === 18 ? 64 : undefined;
  if (
    legacyInteger && integerType &&
    (legacyInteger.width !== integerType.width || legacyInteger.signed !== integerType.signed)
  ) {
    throw invalid("Parquet integer annotations disagree.");
  }
  if (converted !== undefined && legacyWidth === undefined) annotated = true;
  if (
    hasLogical && (!integerType || !integerType.signed ||
      (integerType.width !== 32 && integerType.width !== 64))
  ) annotated = true;
  const identityWidth = integerType?.width ?? legacyWidth;
  if (identityWidth !== undefined && physical !== (identityWidth === 64 ? 2 : 1)) annotated = true;
  return {
    name: required(name, "schema name"),
    ...(physical === undefined ? {} : { physical }),
    ...(typeLength === undefined ? {} : { typeLength }),
    ...(repetition === undefined ? {} : { repetition }),
    ...(children === undefined ? {} : { children }),
    annotated,
  };
}

export function chunk(cursor: Compact): ChunkType {
  cursor.meter.retain(192);
  let metadata: ChunkType | undefined;
  let fileOffset: number | undefined;
  cursor.fields({
    1: (t) => {
      if (cursor.text(t) !== "") throw unsupported("Parquet external column files are unsupported.");
    },
    2: (t) => {
      fileOffset = cursor.number(t, 64);
    },
    3: (t) => {
      cursor.type(t, 12);
      let physical: number | undefined,
        path: string[] | undefined,
        codec: number | undefined,
        encodings: number[] | undefined;
      let values: number | undefined,
        uncompressed: number | undefined,
        stored: number | undefined,
        data: number | undefined;
      let dictionary: number | undefined;
      cursor.fields({
        1: (t) => {
          physical = cursor.number(t);
        },
        2: (t) => {
          encodings = cursor.list(t, 5, 64, () => cursor.number(5));
        },
        3: (t) => {
          path = cursor.list(t, 8, 1, () => cursor.text(8));
        },
        4: (t) => {
          codec = cursor.number(t);
        },
        5: (t) => {
          values = cursor.number(t, 64);
        },
        6: (t) => {
          uncompressed = cursor.number(t, 64);
        },
        7: (t) => {
          stored = cursor.number(t, 64);
        },
        9: (t) => {
          data = cursor.number(t, 64);
        },
        11: (t) => {
          dictionary = cursor.number(t, 64);
        },
      });
      const offset = required(data, "data page offset"),
        start = dictionary === undefined ? offset : Math.min(offset, dictionary);
      metadata = {
        physical: required(physical, "column type"),
        path: required(path, "column path"),
        codec: required(codec, "column codec"),
        encodings: required(encodings, "column encodings"),
        values: required(values, "column value count"),
        uncompressed: required(uncompressed, "uncompressed chunk size"),
        stored: required(stored, "stored chunk size"),
        data: offset,
        ...(dictionary === undefined ? {} : { dictionary }),
        start,
        end: toSafeInteger(BigInt(start) + BigInt(required(stored, "stored chunk size")), `Parquet ${"chunk end"}`),
      };
    },
    8: () => {
      throw unsupported("Parquet encrypted column metadata is unsupported.");
    },
    9: () => {
      throw unsupported("Parquet encrypted columns are unsupported.");
    },
  });
  required(fileOffset, "column file offset");
  return required(metadata, "inline column metadata");
}

export function group(cursor: Compact, maximum: number): GroupType {
  cursor.meter.retain(64);
  let rows: number | undefined, chunks: ChunkType[] | undefined, total: number | undefined;
  cursor.fields({
    1: (t) => {
      chunks = cursor.list(t, 12, maximum, () => chunk(cursor));
    },
    2: (t) => {
      total = cursor.number(t, 64);
    },
    3: (t) => {
      rows = cursor.number(t, 64);
    },
  });
  const columns = required(chunks, "row group columns");
  const expected = columns.reduce((sum, column) => sum + BigInt(column.uncompressed), 0n);
  if (BigInt(required(total, "row group byte size")) !== expected) {
    throw invalid("Parquet row group byte size disagrees with its columns.");
  }
  return { rows: required(rows, "row group rows"), chunks: columns };
}

export interface PageType {
  version: 1 | 2;
  offset: number;
  header: number;
  stored: number;
  decoded: number;
  rows: number;
  encoding: number;
  definition: number;
  repetition: number;
  nulls?: number;
  crc?: number;
}

/** One data page header; no unsupported page is silently treated as rows. */
export function page(cursor: Compact, offset: number): PageType {
  let type: number | undefined, stored: number | undefined, decoded: number | undefined, crc: number | undefined;
  let v1: Omit<PageType, "offset" | "header" | "stored" | "decoded"> | undefined;
  let v2: typeof v1;
  cursor.fields({
    1: (t) => {
      type = cursor.number(t);
    },
    2: (t) => {
      decoded = cursor.number(t);
    },
    3: (t) => {
      stored = cursor.number(t);
    },
    4: (t) => {
      cursor.type(t, 5);
      crc = Number(BigInt.asUintN(32, cursor.signed(32)));
    },
    5: (t) => {
      cursor.type(t, 12);
      let rows: number | undefined,
        encoding: number | undefined,
        definition: number | undefined,
        repetition: number | undefined;
      cursor.fields({
        1: (t) => {
          rows = cursor.number(t);
        },
        2: (t) => {
          encoding = cursor.number(t);
        },
        3: (t) => {
          definition = cursor.number(t);
        },
        4: (t) => {
          repetition = cursor.number(t);
        },
      });
      v1 = {
        version: 1,
        rows: required(rows, "page value count"),
        encoding: required(encoding, "page encoding"),
        definition: required(definition, "definition encoding"),
        repetition: required(repetition, "repetition encoding"),
      };
    },
    6: () => {
      throw unsupported("Parquet index pages are unsupported in the selected column.");
    },
    7: () => {
      throw unsupported("Parquet dictionary pages are unsupported in the selected column.");
    },
    8: (t) => {
      cursor.type(t, 12);
      let count: number | undefined, rows: number | undefined, nulls: number | undefined, encoding: number | undefined;
      let definition: number | undefined, repetition: number | undefined;
      cursor.fields({
        1: (t) => {
          count = cursor.number(t);
        },
        2: (t) => {
          nulls = cursor.number(t);
        },
        3: (t) => {
          rows = cursor.number(t);
        },
        4: (t) => {
          encoding = cursor.number(t);
        },
        5: (t) => {
          definition = cursor.number(t);
        },
        6: (t) => {
          repetition = cursor.number(t);
        },
        7: (t) => {
          cursor.bool(t);
        },
      });
      const size = required(rows, "v2 page rows");
      if (required(count, "v2 page value count") !== size) {
        throw invalid("Parquet flat page row/value counts disagree.");
      }
      v2 = {
        version: 2,
        rows: size,
        encoding: required(encoding, "v2 encoding"),
        nulls: required(nulls, "v2 null count"),
        definition: required(definition, "v2 definition length"),
        repetition: required(repetition, "v2 repetition length"),
      };
      if (v2.nulls! > size) throw invalid("Parquet v2 null count exceeds rows.");
    },
  });
  const kind = required(type, "page type");
  if (kind !== 0 && kind !== 3) throw unsupported("Parquet selected column has an unsupported page type.");
  if ((kind === 0 && (!v1 || v2)) || (kind === 3 && (!v2 || v1))) {
    throw invalid("Parquet page-specific headers contradict its type.");
  }
  return {
    ...required(kind === 0 ? v1 : v2, "data page header"),
    offset,
    header: cursor.at,
    stored: required(stored, "stored page size"),
    decoded: required(decoded, "uncompressed page size"),
    ...(crc === undefined ? {} : { crc }),
  };
}
