/** Bounded numeric ORC previews over a borrowed stable byte source. @module */
import { Bits, Bytes, Integers, values, width } from "./values.ts";
import {
  encoding,
  type SelectedType,
  stream,
  type StreamType,
  stripe,
  type StripeType,
  type,
  type TypeType,
} from "./metadata.ts";
import { limit, Meter, Wire } from "./wire.ts";
import type {
  OrcColumnType,
  OrcDatasetType,
  OrcOpenOptionsType,
  OrcReadOptionsType,
  OrcReadType,
  OrcStripeReadType,
  OrcStripeType,
  OrcValuesType,
  PolicyType,
} from "./types.ts";
import { ArchiveBudget, assertInteger, createArchiveLedger, toSafeInteger } from "../../archive/budget.ts";
import type { ByteSourceType } from "../../source.ts";
import { invalid, unsupported } from "../../archive/error.ts";
import { createView } from "../../archive/field.ts";
import type { ArchiveLedgerType } from "../../archive/budget.ts";
export { ArchiveError } from "../../archive/error.ts";
export { createArchiveLedger } from "../../archive/budget.ts";
export type { ArchiveErrorCodeType } from "../../archive/error.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../../archive/budget.ts";

/** Inspect numeric columns, then decode complete selected column streams in each intersecting stripe.
 * Metadata and values have no checksum/authentication claim. Stable replay is a
 * caller/provider contract and is not established by a source identity alone.
 */
export async function openOrc(input: ByteSourceType, supplied: OrcOpenOptionsType = {}): Promise<OrcDatasetType> {
  const options = { ...supplied };
  if (options.allowUnverifiedSource !== undefined && typeof options.allowUnverifiedSource !== "boolean") {
    throw new TypeError("ORC unverified-source policy must be boolean.");
  }
  const { size, identity, stability } = input;
  assertInteger(size, "ORC source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("ORC identity must be a bounded string.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown ORC source stability.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) {
    throw unsupported("ORC requires stable replay evidence.");
  }
  const source: ByteSourceType = Object.freeze({
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: input.read.bind(input),
  });
  const policy: PolicyType = {
    footer: options.maxFooterBytes ?? 8 * 1024 * 1024,
    stripeFooter: options.maxStripeFooterBytes ?? 1024 * 1024,
    input: options.maxSelectedStreamBytes ?? 16 * 1024 * 1024,
    stripes: options.maxStripes ?? 4096,
    columns: options.maxColumns ?? 1024,
    retained: options.maxRetainedMetadataBytes ?? 8 * 1024 * 1024,
    depth: options.maxDepth ?? 32,
    streams: options.maxStreams ?? 65536,
    string: options.maxStringBytes ?? 65536,
    rows: options.maxRows ?? 1048576,
    steps: options.maxSteps ?? 8388608,
  };
  for (const [name, count] of Object.entries(policy)) assertInteger(count, `ORC maximum ${name}`);
  const captured = new WeakMap<ArchiveLedgerType, ArchiveLedgerType>();
  const capture = (owner: ArchiveLedgerType | undefined): ArchiveLedgerType | undefined => {
    if (!owner) return undefined;
    let saved = captured.get(owner);
    if (!saved) {
      saved = { reserve: owner.reserve.bind(owner), inspect: owner.inspect.bind(owner) };
      captured.set(owner, saved);
    }
    return saved;
  };
  const lifetime = createArchiveLedger(options), opening = capture(options.ledger);
  const together = (owners: readonly (ArchiveLedgerType | undefined)[], signal?: AbortSignal): ArchiveLedgerType => {
    const unique = [...new Set(owners.filter((owner): owner is ArchiveLedgerType => owner !== undefined))];
    return {
      reserve(kind, count) {
        for (const owner of unique) {
          owner.reserve(kind, count);
          signal?.throwIfAborted();
        }
      },
      inspect: () => lifetime.inspect(),
    };
  };
  const budget = new ArchiveBudget(
    source,
    { ...options, ledger: together([lifetime, opening], options.signal) },
    options.signal,
  );
  const meter = new Meter(policy, options.signal);
  const metadata = async (offset: number, count: number): Promise<Uint8Array> => {
    budget.decoded(count);
    options.signal?.throwIfAborted();
    return (await budget.read(offset, count)).slice();
  };
  if (size < 4) throw invalid("ORC file is too short.");
  const header = await metadata(0, 3);
  if (header[0] !== 79 || header[1] !== 82 || header[2] !== 67) throw invalid("ORC header magic is absent.");
  const postLength = (await metadata(size - 1, 1))[0]!;
  if (postLength === 0 || postLength > size - 4) throw invalid("ORC postscript extent is invalid.");
  const postOffset = size - 1 - postLength, post = new Wire(await metadata(postOffset, postLength), meter);
  let footerLength = 0, metadataLength = 0, compression = 0;
  meter.retain(32);
  const version: number[] = [];
  post.fields({
    1: (t) => {
      footerLength = post.number(t);
    },
    2: (t) => {
      compression = post.number(t, 32);
    },
    4: (t) => {
      post.integers(t, version, 2);
    },
    5: (t) => {
      metadataLength = post.number(t);
    },
    7: (t) => {
      if (post.number(t) !== 0) throw unsupported("ORC encrypted stripe statistics are unsupported.");
    },
    8000: (t) => {
      if (post.text(t) !== "ORC") throw invalid("ORC postscript magic disagrees with its header.");
    },
  });
  if (compression !== 0) throw unsupported("ORC generic compression is outside this profile.");
  if (version.length !== 2 || version[0] !== 0 || (version[1] !== 11 && version[1] !== 12)) {
    throw unsupported("ORC file version is unsupported.");
  }
  const formatVersion = version[1] === 11 ? "0.11" : "0.12";
  if (footerLength > policy.footer) limit("File footer byte");
  const tailLength = toSafeInteger(BigInt(footerLength) + BigInt(metadataLength), `ORC ${"tail length"}`);
  if (footerLength === 0 || tailLength > postOffset - 3) throw invalid("ORC footer/metadata extents are invalid.");
  const footerOffset = postOffset - footerLength, metadataStart = postOffset - tailLength;
  const footer = new Wire(await metadata(footerOffset, footerLength), meter);
  let headerLength = 0, contentLength = 0, rows = 0;
  meter.retain(64);
  const declaredStripes: StripeType[] = [], types: TypeType[] = [];
  footer.fields({
    1: (t) => {
      headerLength = footer.number(t);
    },
    2: (t) => {
      contentLength = footer.number(t);
    },
    3: (t) => {
      if (declaredStripes.length >= policy.stripes) limit("Stripe count");
      declaredStripes.push(stripe(footer.message(t)));
    },
    4: (t) => {
      if (types.length > policy.columns) limit("Schema type count");
      types.push(type(footer.message(t)));
    },
    6: (t) => {
      rows = footer.number(t);
    },
    10: () => {
      throw unsupported("ORC encrypted/masked footers are unsupported.");
    },
  });
  if (headerLength !== 3) throw unsupported("ORC profile requires a three-byte header.");
  // The prose includes the header; the official C++ writer excludes it. Both
  // exact conventions are observable; neither relaxes the independent extents.
  const contentLengthBasis = contentLength === metadataStart
    ? "header-and-body"
    : BigInt(contentLength) + BigInt(headerLength) === BigInt(metadataStart)
    ? "body"
    : undefined;
  if (!contentLengthBasis) throw invalid("ORC declared content length disagrees with its tail.");
  const root = types[0];
  if (
    !root || root.kind !== 12 || root.names.length !== root.children.length || root.children.length !== types.length - 1
  ) throw unsupported("ORC requires a flat STRUCT root.");
  meter.retain(types.length * 16 + 64);
  const seen = new Set<number>(), columns: OrcColumnType[] = [];
  for (let index = 0; index < root.children.length; index++) {
    const id = root.children[index]!, child = types[id];
    if (id === 0 || !child || seen.has(id)) throw invalid("ORC schema child ID is invalid or repeated.");
    seen.add(id);
    if (
      child.children.length || child.names.length || child.kind === 12 || child.kind === 10 || child.kind === 11 ||
      child.kind === 13
    ) throw unsupported("ORC nested schemas are unsupported.");
    meter.retain(96);
    const supported = width(child.kind) !== 0;
    columns.push(
      Object.freeze({
        id,
        name: root.names[index]!,
        kind: child.kind,
        supported,
        ...(supported ? {} : { reason: "ORC leaf is outside the physical numeric profile." }),
      }),
    );
  }
  meter.retain(32);
  const stripes: OrcStripeType[] = [];
  let end = headerLength, rowOffset = 0;
  for (let id = 0; id < declaredStripes.length; id++) {
    const stripe = declaredStripes[id]!;
    const next = toSafeInteger(
      BigInt(stripe.offset) + BigInt(stripe.index) + BigInt(stripe.data) + BigInt(stripe.footer),
      `ORC ${"stripe end"}`,
    );
    if (stripe.offset !== end || next > metadataStart || stripe.footer === 0) {
      throw invalid("ORC stripes overlap, contain unsupported padding, or exceed the body.");
    }
    meter.retain(96);
    stripes.push(
      Object.freeze({
        id,
        offset: stripe.offset,
        rowOffset,
        rows: stripe.rows,
        indexBytes: stripe.index,
        dataBytes: stripe.data,
        footerBytes: stripe.footer,
      }),
    );
    rowOffset = toSafeInteger(BigInt(rowOffset) + BigInt(stripe.rows), `ORC ${"row count"}`);
    end = next;
  }
  if (end !== metadataStart || rowOffset !== rows) {
    throw invalid("ORC stripes disagree with body extent or file row count.");
  }
  options.signal?.throwIfAborted();
  return Object.freeze({
    rows,
    columns: Object.freeze(columns),
    stripes: Object.freeze(stripes),
    formatVersion,
    contentLengthBasis,
    integrity: "none",
    work: Object.freeze(budget.inspect()),
    async read(columnId: number, supplied: OrcReadOptionsType = {}): Promise<OrcReadType> {
      const opts = { ...supplied };
      assertInteger(columnId, "ORC column ID");
      const column = columns.find((column) => column.id === columnId);
      if (!column) throw new RangeError("ORC column ID is absent.");
      if (!column.supported) throw unsupported(column.reason!);
      const signal = options.signal && opts.signal
        ? AbortSignal.any([options.signal, opts.signal])
        : options.signal ?? opts.signal;
      signal?.throwIfAborted();
      const offset = opts.offset ?? 0, length = opts.length ?? rows - offset;
      assertInteger(offset, "ORC row offset");
      assertInteger(length, "ORC row length");
      if (offset > rows || length > rows - offset) throw new RangeError("ORC row selection exceeds the file.");
      if (length > policy.rows) limit("Returned row");
      const owners = together([lifetime, opening, capture(opts.ledger)], signal);
      const credits = { sourceBytes: 0, requests: 0 };
      const operation = new ArchiveBudget(source, {
        ...opts,
        ledger: {
          reserve(kind, count) {
            if ((kind === "sourceBytes" || kind === "requests") && credits[kind] >= count) credits[kind] -= count;
            else owners.reserve(kind, count);
            signal?.throwIfAborted();
          },
          inspect: () => lifetime.inspect(),
        },
      }, signal);
      const readMeter = new Meter(policy, signal);
      readMeter.retain(64);
      const selected: SelectedType[] = [];
      let inputBytes = 0, requests = 0, decodedRows = 0;
      for (const stripe of stripes) {
        if (length === 0 || stripe.rowOffset >= offset + length || stripe.rowOffset + stripe.rows <= offset) continue;
        if (stripe.footerBytes > policy.stripeFooter) limit("Stripe footer byte");
        operation.decoded(stripe.footerBytes);
        signal?.throwIfAborted();
        const cursor = new Wire(
          (await operation.read(stripe.offset + stripe.indexBytes + stripe.dataBytes, stripe.footerBytes)).slice(),
          readMeter,
        );
        readMeter.retain(64);
        const streams: Omit<StreamType, "offset">[] = [], encodings: number[] = [];
        cursor.fields({
          1: (t) => {
            if (readMeter.streams >= policy.streams) limit("Stream count");
            readMeter.streams++;
            streams.push(stream(cursor.message(t)));
          },
          2: (t) => {
            if (encodings.length >= types.length) throw invalid("ORC stripe has excess column encodings.");
            encodings.push(encoding(cursor.message(t)));
          },
          3: (t) => {
            cursor.text(t);
          },
          4: () => {
            throw unsupported("ORC encrypted stripe variants are unsupported.");
          },
        });
        if (encodings.length !== types.length) throw invalid("ORC stripe encoding count disagrees with schema.");
        if (encodings[column.id] !== 0) {
          throw unsupported("ORC selected column requires DIRECT encoding; RLEv2/dictionaries are unsupported.");
        }
        let at = stripe.offset, indexBytes = 0;
        const dataStart = stripe.offset + stripe.indexBytes, footerStart = dataStart + stripe.dataBytes;
        readMeter.retain(streams.length * 16 + 96);
        const identities = new Set<string>();
        let present: StreamType | undefined, data: StreamType | undefined;
        for (const stream of streams) {
          const identity = `${stream.column}:${stream.kind}`;
          if (stream.column >= types.length || identities.has(identity)) {
            throw invalid("ORC stream column/kind is invalid or repeated.");
          }
          identities.add(identity);
          const next = toSafeInteger(BigInt(at) + BigInt(stream.length), `ORC ${"stream end"}`);
          const indexStream = stream.kind >= 6;
          if (indexStream) {
            if (at > dataStart || next > dataStart) throw invalid("ORC index stream exceeds its declared section.");
            indexBytes = toSafeInteger(BigInt(indexBytes) + BigInt(stream.length), `ORC ${"index stream bytes"}`);
          } else if (at < dataStart || next > footerStart) {
            throw invalid("ORC data stream exceeds its declared section.");
          }
          if (stream.column === 0 && stream.kind < 6) {
            throw unsupported("ORC root value/presence streams are outside the flat profile.");
          }
          if (stream.column === column.id && !indexStream) {
            const extent = { ...stream, offset: at };
            if (stream.kind === 0) present = extent;
            else if (stream.kind === 1) data = extent;
            else throw unsupported("ORC selected numeric column has an unsupported stream role.");
          }
          at = next;
        }
        if (indexBytes !== stripe.indexBytes || at !== footerStart) {
          throw invalid("ORC stream lengths disagree with stripe sections.");
        }
        const stored = toSafeInteger(
          BigInt(present?.length ?? 0) + BigInt(data?.length ?? 0),
          `ORC ${"selected stream bytes"}`,
        );
        inputBytes = toSafeInteger(BigInt(inputBytes) + BigInt(stored), `ORC ${"aggregate selected stream bytes"}`);
        if (inputBytes > policy.input) limit("Selected stream byte");
        requests += Number((present?.length ?? 0) !== 0) + Number((data?.length ?? 0) !== 0);
        decodedRows = toSafeInteger(BigInt(decodedRows) + BigInt(stripe.rows), `ORC ${"decoded rows"}`);
        selected.push({ stripe, ...(present ? { present } : {}), ...(data ? { data } : {}), stored });
      }
      readMeter.admitSteps(decodedRows);
      const current = operation.inspect();
      if (
        inputBytes > operation.limits.maxSourceBytes - current.sourceBytes ||
        requests > operation.limits.maxRequests - current.requests
      ) limit("Selected source/request");
      owners.reserve("sourceBytes", inputBytes);
      owners.reserve("requests", requests);
      credits.sourceBytes = inputBytes;
      credits.requests = requests;
      const outputBytes = toSafeInteger(BigInt(length) * BigInt(width(column.kind) + 1), `ORC ${"output bytes"}`);
      operation.decoded(inputBytes);
      operation.decoded(
        toSafeInteger(
          BigInt(decodedRows) * BigInt(width(column.kind) + 1) + BigInt(outputBytes),
          `ORC ${"decoded/copy bytes"}`,
        ),
      );
      operation.output(outputBytes);
      signal?.throwIfAborted();
      const output = values(column.kind, length), validity = new Uint8Array(length), evidence: OrcStripeReadType[] = [];
      for (const plan of selected) {
        const read = async (stream: StreamType | undefined): Promise<Uint8Array> =>
          stream && stream.length !== 0
            ? (await operation.read(stream.offset, stream.length)).slice()
            : new Uint8Array();
        const presentBytes = await read(plan.present), dataBytes = await read(plan.data);
        const present = plan.present ? new Bits(presentBytes, readMeter) : undefined;
        const boolean = column.kind === 0 ? new Bits(dataBytes, readMeter) : undefined;
        const byte = column.kind === 1 ? new Bytes(dataBytes, readMeter) : undefined;
        const integers = column.kind >= 2 && column.kind <= 4 ? new Integers(dataBytes, readMeter) : undefined;
        const dataView = createView(dataBytes);
        let position = 0, presentCount = 0;
        for (let row = 0; row < plan.stripe.rows; row++) {
          readMeter.step();
          const valid = present ? present.next() : true;
          const target = plan.stripe.rowOffset + row - offset;
          if (!valid) continue;
          presentCount++;
          let value: number | bigint;
          if (boolean) value = Number(boolean.next());
          else if (byte) {
            const raw = byte.next();
            value = raw < 128 ? raw : raw - 256;
          } else if (integers) {
            const raw = integers.next(), bits = width(column.kind) * 8;
            if (raw < -(1n << BigInt(bits - 1)) || raw >= (1n << BigInt(bits - 1))) {
              throw invalid("ORC integer exceeds its declared signed width.");
            }
            value = column.kind === 4 ? raw : Number(raw);
          } else {
            if (position > dataBytes.length - width(column.kind)) throw invalid("ORC IEEE value stream is truncated.");
            value = column.kind === 5 ? dataView.getFloat32(position, true) : dataView.getFloat64(position, true);
            position += width(column.kind);
          }
          if (target >= 0 && target < length) {
            validity[target] = 1;
            if (typeof value === "bigint") (output as BigInt64Array)[target] = value;
            else (output as Exclude<OrcValuesType, BigInt64Array>)[target] = value;
          }
        }
        present?.end();
        boolean?.end();
        byte?.end();
        integers?.end();
        if ((column.kind === 5 || column.kind === 6) && position !== dataBytes.length) {
          throw invalid("ORC IEEE stream has trailing bytes.");
        }
        if (!plan.data && presentCount !== 0) throw invalid("ORC non-null column values have no DATA stream.");
        readMeter.retain(64);
        evidence.push(
          Object.freeze({
            id: plan.stripe.id,
            rows: plan.stripe.rows,
            selectedRows: Math.max(
              0,
              Math.min(plan.stripe.rowOffset + plan.stripe.rows, offset + length) -
                Math.max(plan.stripe.rowOffset, offset),
            ),
            storedBytes: plan.stored,
            encoding: "DIRECT",
          }),
        );
      }
      signal?.throwIfAborted();
      return {
        values: output,
        validity,
        stripes: Object.freeze(evidence),
        integrity: "none",
        scope: "selected-column-stripes",
        work: operation.inspect(),
      };
    },
  });
}

export type {
  OrcColumnType,
  OrcDatasetType,
  OrcOpenOptionsType,
  OrcReadOptionsType,
  OrcReadType,
  OrcStripeReadType,
  OrcStripeType,
  OrcValuesType,
} from "./types.ts";
