// Selected web-platform-tests cases, BSD-3-Clause. See provenance.json and licenses/wpt.md.
// Callback bodies and titles retain the upstream oracle; ownership additions are documented separately.
import { withReleases } from "../close.ts";

/** Payloads admitted by the selected upstream callbacks, narrower than the facade's full input API. */
export type WptChunkType = string | Blob | ArrayBuffer | {
  type: "write";
  position?: number;
  data: string | Blob | ArrayBuffer;
} | { type: "seek"; position: number };

/** Structural byte-operation port; this does not assert native WebIDL branding. */
export interface FileType {
  readonly kind: string;
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<StreamType>;
}
/** Only the writable methods used by the retained cases are required. */
export type StreamType = WritableStream<WptChunkType> & {
  write(value: WptChunkType): Promise<void>;
  close(): Promise<void>;
};
/** Directory lookup has the same positive create/read contract on both tested routes. */
export interface RootType {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileType>;
}
/** The harness registers each writer and stream immediately after acquisition. */
export interface ContextType {
  open(file: FileType): Promise<StreamType>;
  writer(stream: StreamType): WritableStreamDefaultWriter<WptChunkType>;
}
/** One copied upstream callback with its original test identity. */
export interface DirectoryCaseType {
  readonly name: string;
  run(context: ContextType, root: RootType): Promise<void>;
}
/** Only byte views supported by every selected sync route are admitted. */
export interface SyncType {
  read(buffer: Uint8Array<ArrayBuffer>, options?: { at?: number }): number;
  write(buffer: Uint8Array<ArrayBuffer>, options?: { at?: number }): number;
  getSize(): number;
  truncate(size: number): void;
}
/** One original sync callback, independent of browser worker admission. */
export interface SyncCaseType {
  readonly name: string;
  run(context: object, file: SyncType): void;
}
/** Identifies a copied upstream oracle failure separately from fixture or host failures. */
export class WptAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WptAssertionError";
  }
}

/** Fails on the original scalar oracle, including its diagnostic message. */
function assert_equals(actual: unknown, expected: unknown, message = "Values differ"): void {
  if (!Object.is(actual, expected)) {
    throw new WptAssertionError(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
/** Compares every original byte rather than only a size or aggregate hash. */
function assert_array_equals(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  assert_equals(actual.length, expected.length, "Byte lengths differ");
  for (let index = 0; index < actual.length; index++) assert_equals(actual[index], expected[index], `Byte ${index}`);
}
/** Preserves the upstream prefix and implemented-operation checks. */
function assert_true(value: boolean, message = "Expected true"): void {
  if (!value) throw new WptAssertionError(message);
}
/** Preserves the original unlocked-stream assertion. */
function assert_false(value: boolean): void {
  assert_equals(value, false);
}
/** Rejects a missing sync operation before size checks could pass accidentally. */
function assert_implements(value: unknown, message: string): void {
  if (typeof value !== "function") throw new WptAssertionError(message);
}
/** Fresh case namespaces make this positive creation helper deterministic. */
async function createEmptyFile(name: string, root: RootType): Promise<FileType> {
  return await root.getFileHandle(name, { create: true });
}
/** Setup commits its initial bytes and aborts/releases even when setup itself fails. */
async function createFileWithContents(name: string, value: string, root: RootType): Promise<FileType> {
  return await withReleases(async (releases) => {
    const file = await createEmptyFile(name, root);
    const stream = await file.createWritable();
    releases.push(() => stream.abort());
    await stream.write(value);
    await stream.close();
    return file;
  });
}
async function getFileContents(file: FileType): Promise<string> {
  return await (await file.getFile()).text();
}
async function getFileSize(file: FileType): Promise<number> {
  return (await file.getFile()).size;
}
/** Fresh namespace ownership remains the caller's responsibility. */
export async function runDirectoryCase(test: DirectoryCaseType, root: RootType): Promise<void> {
  await withReleases(async (releases) => {
    await test.run({
      async open(file) {
        const stream = await file.createWritable();
        releases.push(() => stream.abort());
        return stream;
      },
      writer(stream) {
        const writer = stream.getWriter();
        releases.push(() => writer.releaseLock());
        return writer;
      },
    }, root);
  });
}
/** Upstream titles are stable provenance and human-readable runtime test identities. */
export const directoryCases: DirectoryCaseType[] = [];
function directory_test(run: DirectoryCaseType["run"], name: string): void {
  directoryCases.push({ name, run });
}
export const syncCases: SyncCaseType[] = [];
function sync_access_handle_test(run: SyncCaseType["run"], name: string): void {
  syncCases.push({ name, run });
}
directory_test(async (t, root) => {
  const handle = await createEmptyFile("empty_blob", root);
  const stream = await t.open(handle);

  await stream.write(new Blob([]));
  await stream.close();

  assert_equals(await getFileContents(handle), "");
  assert_equals(await getFileSize(handle), 0);
}, "write() with an empty blob to an empty file");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("valid_blob", root);
  const stream = await t.open(handle);

  await stream.write(new Blob(["1234567890"]));
  await stream.close();

  assert_equals(await getFileContents(handle), "1234567890");
  assert_equals(await getFileSize(handle), 10);
}, "write() a blob to an empty file");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("write_param_empty", root);
  const stream = await t.open(handle);

  await stream.write({ type: "write", data: "1234567890" });
  await stream.close();

  assert_equals(await getFileContents(handle), "1234567890");
  assert_equals(await getFileSize(handle), 10);
}, "write() with WriteParams without position to an empty file");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("string_zero_offset", root);
  const stream = await t.open(handle);

  await stream.write({ type: "write", position: 0, data: "1234567890" });
  await stream.close();

  assert_equals(await getFileContents(handle), "1234567890");
  assert_equals(await getFileSize(handle), 10);
}, "write() a string to an empty file with zero offset");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("blob_zero_offset", root);
  const stream = await t.open(handle);

  await stream.write(
    { type: "write", position: 0, data: new Blob(["1234567890"]) },
  );
  await stream.close();

  assert_equals(await getFileContents(handle), "1234567890");
  assert_equals(await getFileSize(handle), 10);
}, "write() a blob to an empty file with zero offset");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("write_appends", root);
  const stream = await t.open(handle);

  await stream.write("12345");
  await stream.write("67890");
  await stream.close();

  assert_equals(await getFileContents(handle), "1234567890");
  assert_equals(await getFileSize(handle), 10);
}, "write() called consecutively appends");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("write_appends_object_string", root);
  const stream = await t.open(handle);

  await stream.write("12345");
  await stream.write({ type: "write", data: "67890" });
  await stream.close();

  assert_equals(await getFileContents(handle), "1234567890");
  assert_equals(await getFileSize(handle), 10);
}, "write() WriteParams without position and string appends");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("write_appends_object_blob", root);
  const stream = await t.open(handle);

  await stream.write("12345");
  await stream.write({ type: "write", data: new Blob(["67890"]) });
  await stream.close();

  assert_equals(await getFileContents(handle), "1234567890");
  assert_equals(await getFileSize(handle), 10);
}, "write() WriteParams without position and blob appends");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("string_with_offset", root);
  const stream = await t.open(handle);

  await stream.write("1234567890");
  await stream.write({ type: "write", position: 4, data: "abc" });
  await stream.close();

  assert_equals(await getFileContents(handle), "1234abc890");
  assert_equals(await getFileSize(handle), 10);
}, "write() called with a string and a valid offset");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("write_string_with_offset_after_seek", root);
  const stream = await t.open(handle);

  await stream.write("1234567890");
  await stream.write({ type: "seek", position: 0 });
  await stream.write({ type: "write", position: 4, data: "abc" });
  await stream.close();

  assert_equals(await getFileContents(handle), "1234abc890");
  assert_equals(await getFileSize(handle), 10);
}, "write() called with a string and a valid offset after seek");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("blob_with_offset", root);
  const stream = await t.open(handle);

  await stream.write("1234567890");
  await stream.write({ type: "write", position: 4, data: new Blob(["abc"]) });
  await stream.close();

  assert_equals(await getFileContents(handle), "1234abc890");
  assert_equals(await getFileSize(handle), 10);
}, "write() called with a blob and a valid offset");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("bad_offset", root);
  const stream = await t.open(handle);

  await stream.write({ type: "write", position: 4, data: new Blob(["abc"]) });
  await stream.close();

  assert_equals(await getFileContents(handle), "\0\0\0\0abc");
  assert_equals(await getFileSize(handle), 7);
}, "write() called with an offset beyond the end of the file");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("empty_string", root);
  const stream = await t.open(handle);

  await stream.write("");
  await stream.close();
  assert_equals(await getFileContents(handle), "");
  assert_equals(await getFileSize(handle), 0);
}, "write() with an empty string to an empty file");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("valid_utf8_string", root);
  const stream = await t.open(handle);

  await stream.write("foo🤘");
  await stream.close();
  assert_equals(await getFileContents(handle), "foo🤘");
  assert_equals(await getFileSize(handle), 7);
}, "write() with a valid utf-8 string");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("string_with_unix_line_ending", root);
  const stream = await t.open(handle);

  await stream.write("foo\n");
  await stream.close();
  assert_equals(await getFileContents(handle), "foo\n");
  assert_equals(await getFileSize(handle), 4);
}, "write() with a string with unix line ending preserved");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("string_with_windows_line_ending", root);
  const stream = await t.open(handle);

  await stream.write("foo\r\n");
  await stream.close();
  assert_equals(await getFileContents(handle), "foo\r\n");
  assert_equals(await getFileSize(handle), 5);
}, "write() with a string with windows line ending preserved");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("empty_array_buffer", root);
  const stream = await t.open(handle);

  const buf = new ArrayBuffer(0);
  await stream.write(buf);
  await stream.close();
  assert_equals(await getFileContents(handle), "");
  assert_equals(await getFileSize(handle), 0);
}, "write() with an empty array buffer to an empty file");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("valid_string_typed_byte_array", root);
  const stream = await t.open(handle);

  const buf = new ArrayBuffer(3);
  const intView = new Uint8Array(buf);
  intView[0] = 0x66;
  intView[1] = 0x6f;
  intView[2] = 0x6f;
  await stream.write(buf);
  await stream.close();
  assert_equals(await getFileContents(handle), "foo");
  assert_equals(await getFileSize(handle), 3);
}, "write() with a valid typed array buffer");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("atomic_writes.txt", root);
  const stream = await t.open(handle);
  await stream.write("foox");

  const stream2 = await t.open(handle);
  await stream2.write("bar");

  assert_equals(await getFileSize(handle), 0);

  await stream2.close();
  assert_equals(await getFileContents(handle), "bar");
  assert_equals(await getFileSize(handle), 3);

  await stream.close();
  assert_equals(await getFileContents(handle), "foox");
  assert_equals(await getFileSize(handle), 4);
}, "atomic writes: writable file streams make atomic changes on close");

directory_test(async (t, root) => {
  const handle = await createEmptyFile("writer_written", root);
  const stream = await t.open(handle);
  assert_false(stream.locked);
  const writer = t.writer(stream);
  assert_true(stream.locked);

  await writer.write("foo");
  await writer.write(new Blob(["bar"]));
  await writer.write({ type: "seek", position: 0 });
  await writer.write({ type: "write", data: "baz" });
  await writer.close();

  assert_equals(await getFileContents(handle), "bazbar");
  assert_equals(await getFileSize(handle), 6);
}, "getWriter() can be used");

directory_test(async (_t, dir) => {
  const handle = await dir.getFileHandle("non-existing-file", { create: true });

  assert_equals(handle.kind, "file");
  assert_equals(handle.name, "non-existing-file");
  assert_equals(await getFileSize(handle), 0);
  assert_equals(await getFileContents(handle), "");
}, "getFileHandle(create=true) creates an empty file for non-existing files");

directory_test(async (_t, dir) => {
  // A non-ASCII name
  const name = "Funny cat \u{1F639}";
  const handle = await dir.getFileHandle(name, { create: true });

  assert_equals(handle.kind, "file");
  assert_equals(handle.name, name);
  assert_equals(await getFileSize(handle), 0);
  assert_equals(await getFileContents(handle), "");
}, "getFileHandle(create=true) creates an empty file with non-ASCII characters in the name");

directory_test(async (_t, dir) => {
  await createFileWithContents(
    "existing-file",
    "1234567890",
    /*parent=*/ dir,
  );
  const handle = await dir.getFileHandle("existing-file");

  assert_equals(handle.kind, "file");
  assert_equals(handle.name, "existing-file");
  assert_equals(await getFileSize(handle), 10);
  assert_equals(await getFileContents(handle), "1234567890");
}, "getFileHandle(create=false) returns existing files");

directory_test(async (_t, dir) => {
  await createFileWithContents(
    "file-with-contents",
    "1234567890",
    /*parent=*/ dir,
  );
  const handle = await dir.getFileHandle("file-with-contents", { create: true });

  assert_equals(handle.kind, "file");
  assert_equals(handle.name, "file-with-contents");
  assert_equals(await getFileSize(handle), 10);
  assert_equals(await getFileContents(handle), "1234567890");
}, "getFileHandle(create=true) returns existing files without erasing");

sync_access_handle_test((_t, handle) => {
  const readBuffer = new Uint8Array(24);
  const readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(0, readBytes, "Check that no bytes were read");
}, "Test reading an empty file through a sync access handle.");

sync_access_handle_test((_t, handle) => {
  const decoder = new TextDecoder();

  const text = "Hello Storage Foundation";
  const writeBuffer = new TextEncoder().encode(text);
  const writtenBytes = handle.write(writeBuffer, { at: 0 });
  assert_equals(
    writeBuffer.byteLength,
    writtenBytes,
    "Check that all bytes were written.",
  );
  let readBuffer = new Uint8Array(writtenBytes);
  let readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(writtenBytes, readBytes, "Check that all bytes were read");
  assert_equals(
    text,
    decoder.decode(readBuffer),
    "Check that the written bytes and the read bytes match",
  );

  // Test a read of less bytes than available.
  const expected = "Storage";
  readBuffer = new Uint8Array(expected.length);
  readBytes = handle.read(readBuffer, { at: text.indexOf(expected) });
  assert_equals(readBuffer.length, readBytes, "Check that all bytes were read");
  const actual = decoder.decode(readBuffer);
  assert_equals(
    expected,
    actual,
    "Partial read returned unexpected contents",
  );
}, "Test writing and reading through a sync access handle.");

sync_access_handle_test((_t, handle) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  for (const text of ["Hello", "Longer Text"]) {
    const writeBuffer = encoder.encode(text);
    const writtenBytes = handle.write(writeBuffer, { at: 0 });
    assert_equals(
      writeBuffer.byteLength,
      writtenBytes,
      "Check that all bytes were written.",
    );
    const readBuffer = new Uint8Array(writtenBytes);
    const readBytes = handle.read(readBuffer, { at: 0 });
    assert_equals(writtenBytes, readBytes, "Check that all bytes were read");
    assert_equals(
      text,
      decoder.decode(readBuffer),
      "Check that the written bytes and the read bytes match",
    );
  }
}, "Test second write that is bigger than the first write");

sync_access_handle_test((_t, handle) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  for (
    const tuple of [{ input: "Hello World", expected: "Hello World" }, { input: "foobar", expected: "foobarWorld" }]
  ) {
    const text = tuple.input;
    const expected = tuple.expected;
    const writeBuffer = encoder.encode(text);
    const writtenBytes = handle.write(writeBuffer, { at: 0 });
    assert_equals(
      writeBuffer.byteLength,
      writtenBytes,
      "Check that all bytes were written.",
    );
    const readBuffer = new Uint8Array(expected.length);
    const readBytes = handle.read(readBuffer, { at: 0 });
    assert_equals(expected.length, readBytes, "Check that all bytes were read");
    assert_equals(
      expected,
      decoder.decode(readBuffer),
      "Check that the written bytes and the read bytes match",
    );
  }
}, "Test second write that is smaller than the first write");

sync_access_handle_test((_t, handle) => {
  const expected = 17;
  const writeBuffer = new Uint8Array(1);
  writeBuffer[0] = expected;
  const offset = 5;
  const writtenBytes = handle.write(writeBuffer, { at: offset });
  assert_equals(
    writeBuffer.byteLength,
    writtenBytes,
    "Check that all bytes were written.",
  );
  const fileLength = writeBuffer.byteLength + offset;
  const readBuffer = new Uint8Array(fileLength);
  const readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(fileLength, readBytes, "Check that all bytes were read");
  for (let i = 0; i < offset; ++i) {
    assert_equals(
      readBuffer[i],
      0,
      `Gaps in the file should be filled with 0, but got ${readBuffer[i]}.`,
    );
  }

  assert_equals(
    readBuffer[offset],
    expected,
    "Gaps in the file should be filled with 0.",
  );
}, "Test initial write with an offset");

sync_access_handle_test((_t, handle) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  for (
    const tuple of [{ input: "Hello World", expected: "Hello World", offset: 0 }, {
      input: "foobar",
      expected: "Hello foobar",
      offset: 6,
    }]
  ) {
    const text = tuple.input;
    const expected = tuple.expected;
    const offset = tuple.offset;
    const writeBuffer = encoder.encode(text);
    const writtenBytes = handle.write(writeBuffer, { at: offset });
    assert_equals(
      writeBuffer.byteLength,
      writtenBytes,
      "Check that all bytes were written.",
    );
    const readBuffer = new Uint8Array(expected.length);
    const readBytes = handle.read(readBuffer, { at: 0 });
    assert_equals(expected.length, readBytes, "Check that all bytes were read");
    const actual = decoder.decode(readBuffer);
    assert_equals(
      expected,
      actual,
      "Check content read from the handle",
    );
  }
}, "Test overwriting the file at an offset");

sync_access_handle_test((_t, handle) => {
  const decoder = new TextDecoder();

  const text = "Hello Storage Foundation";
  const writeBuffer = new TextEncoder().encode(text);
  const writtenBytes = handle.write(writeBuffer, { at: 0 });
  assert_equals(
    writeBuffer.byteLength,
    writtenBytes,
    "Check that all bytes were written.",
  );
  const bufferLength = text.length;
  for (const tuple of [{ offset: 0, expected: text }, { offset: 6, expected: text.substring(6) }]) {
    const offset = tuple.offset;
    const expected = tuple.expected;

    const readBuffer = new Uint8Array(bufferLength);
    const readBytes = handle.read(readBuffer, { at: offset });
    assert_equals(expected.length, readBytes, "Check that all bytes were read");
    const actual = decoder.decode(readBuffer);
    assert_true(
      actual.startsWith(expected),
      `Expected to read ${expected} but the actual value was ${actual}.`,
    );
  }

  const readBuffer = new Uint8Array(bufferLength);
  // Offset is greater than the file length.
  const readBytes = handle.read(readBuffer, { at: bufferLength + 1 });
  assert_equals(0, readBytes, "Check that no bytes were read");
  for (let i = 0; i < readBuffer.byteLength; ++i) {
    assert_equals(0, readBuffer[i], "Check that the read buffer is unchanged.");
  }
}, "Test read at an offset");

sync_access_handle_test((_t, handle) => {
  const expected = "Hello Storage Foundation";
  const writeBuffer = new TextEncoder().encode(expected);
  const writtenBytes = handle.write(writeBuffer, { at: 0 });
  assert_equals(
    writeBuffer.byteLength,
    writtenBytes,
    "Check that all bytes were written.",
  );

  const readBuffer = new Uint8Array(expected.length);
  // No options parameter provided, should read at offset 0.
  const readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(expected.length, readBytes, "Check that all bytes were read");
  const actual = new TextDecoder().decode(readBuffer);
  assert_equals(
    expected,
    actual,
    `Expected to read ${expected} but the actual value was ${actual}.`,
  );
}, "Test read with default options");

sync_access_handle_test((_t, handle) => {
  const expected = "Hello Storage Foundation";
  const writeBuffer = new TextEncoder().encode(expected);
  // No options parameter provided, should write at offset 0.
  const writtenBytes = handle.write(writeBuffer);
  assert_equals(
    writeBuffer.byteLength,
    writtenBytes,
    "Check that all bytes were written.",
  );

  const readBuffer = new Uint8Array(expected.length);
  const readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(expected.length, readBytes, "Check that all bytes were read");
  const actual = new TextDecoder().decode(readBuffer);
  assert_equals(
    expected,
    actual,
    `Expected to read ${expected} but the actual value was ${actual}.`,
  );
}, "Test write with default options");

sync_access_handle_test((_t, handle) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let writeBuffer = encoder.encode("Hello ");
  let writtenBytes = handle.write(writeBuffer);
  writeBuffer = encoder.encode("World");
  writtenBytes += handle.write(writeBuffer);
  let readBuffer = new Uint8Array(256);
  let readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(readBytes, "Hello World".length, "Check that all bytes were read");
  let actual = decoder.decode(readBuffer).substring(0, readBytes);
  assert_equals(
    actual,
    "Hello World",
    "Check content read from the handle",
  );

  readBuffer = new Uint8Array(5);
  readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(readBytes, 5, "Check that all bytes were read");
  actual = decoder.decode(readBuffer).substring(0, readBytes);
  assert_equals(
    actual,
    "Hello",
    "Check content read from the handle",
  );

  readBuffer = new Uint8Array(256);
  readBytes = handle.read(readBuffer);
  assert_equals(readBytes, "Hello World".length - 5, "Check that all bytes were read");
  actual = decoder.decode(readBuffer).substring(0, readBytes);
  assert_equals(
    actual,
    " World",
    "Check content read from the handle",
  );

  readBuffer = new Uint8Array(5);
  readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(readBytes, 5, "Check that all bytes were read");
  actual = decoder.decode(readBuffer);
  assert_equals(
    actual,
    "Hello",
    "Check content read from the handle",
  );
  writeBuffer = encoder.encode(" X");
  writtenBytes = handle.write(writeBuffer);
  assert_equals(writtenBytes, 2, "Check overwrite length");

  readBuffer = new Uint8Array(256);
  readBytes = handle.read(readBuffer, { at: 0 });
  assert_equals(readBytes, "Hello Xorld".length, "Check that all bytes were read");
  actual = decoder.decode(readBuffer).substring(0, readBytes);
  assert_equals(
    actual,
    "Hello Xorld",
    "Check content read from the handle",
  );
}, "Test reading and writing a file using the cursor");

sync_access_handle_test((_t, handle) => {
  // Without this assertion, the test passes even if truncate is not defined.
  assert_implements(handle.truncate, "SyncAccessHandle.truncate is not implemented.");

  handle.truncate(4);
  assert_equals(handle.getSize(), 4);
  handle.truncate(2);
  assert_equals(handle.getSize(), 2);
  handle.truncate(7);
  assert_equals(handle.getSize(), 7);
  handle.truncate(0);
  assert_equals(handle.getSize(), 0);
}, "test SyncAccessHandle.truncate with different sizes");

sync_access_handle_test((_t, handle) => {
  const writeBuffer = new Uint8Array(4);
  writeBuffer.set([96, 97, 98, 99]);
  handle.write(writeBuffer, { at: 0 });

  handle.truncate(2);
  const readBuffer = new Uint8Array(6);
  assert_equals(2, handle.read(readBuffer, { at: 0 }));
  const expected = new Uint8Array(6);
  expected.set([96, 97, 0, 0, 0, 0]);
  assert_array_equals(expected, readBuffer);

  // Resize the file to 6, expect that everything beyond the old size is '0'.
  handle.truncate(6);
  assert_equals(6, handle.read(readBuffer, { at: 0 }));
  assert_array_equals(expected, readBuffer);
}, "test SyncAccessHandle.truncate after SyncAccessHandle.write");

sync_access_handle_test((_t, handle) => {
  const writeBuffer = new Uint8Array(4);
  writeBuffer.set([96, 97, 98, 99]);
  handle.write(writeBuffer, { at: 0 });

  // Moves cursor to 2
  handle.truncate(2);
  const readBuffer = new Uint8Array(256);
  assert_equals(handle.read(readBuffer), 0);

  writeBuffer.set([100, 101, 102, 103]);
  handle.write(writeBuffer);

  assert_equals(handle.read(readBuffer, { at: 0 }), 6);
  let expected = new Uint8Array(256);
  expected.set([96, 97, 100, 101, 102, 103]);
  assert_array_equals(readBuffer, expected);

  // Resize the file to 10, expect that everything beyond the old size is '0'.
  handle.truncate(10); // file cursor should still be at 6
  // overwrite two bytes
  const writeBuffer2 = new Uint8Array(2);
  writeBuffer2.set([110, 111]);
  handle.write(writeBuffer2);
  expected = new Uint8Array(256);
  expected.set([96, 97, 100, 101, 102, 103, 110, 111, 0, 0]);
  assert_equals(handle.read(readBuffer, { at: 0 }), 10);
  assert_array_equals(readBuffer, expected);
}, "Test truncate effect on cursor");
