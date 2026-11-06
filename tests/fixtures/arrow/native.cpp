// Authored native fixture harness. Arrow C++ owns wire encoding and decoding.
// Inputs are original little-endian values plus one-byte validity, not candidate output.
#include <arrow/api.h>
#include <arrow/io/api.h>
#include <arrow/adapters/orc/adapter.h>
#include <arrow/adapters/orc/options.h>
#include <parquet/arrow/reader.h>
#include <parquet/arrow/writer.h>
#include <parquet/file_reader.h>
#include <parquet/metadata.h>
#include <parquet/properties.h>
#include <parquet/types.h>

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
constexpr std::uintmax_t FILE_LIMIT = 32 * 1024 * 1024;

static void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
static void check(const arrow::Status& status) {
  if (!status.ok()) throw std::runtime_error(status.ToString());
}
template <typename T> static T take(arrow::Result<T> result) {
  check(result.status());
  return std::move(result).ValueUnsafe();
}

// A file is admitted before allocation. Native outputs belong only to fresh TS temp directories.
static std::vector<std::uint8_t> read(const fs::path& path) {
  require(fs::is_regular_file(fs::symlink_status(path)), "Expected a regular native input");
  const auto size = fs::file_size(path);
  require(size <= FILE_LIMIT, "Native input exceeds file budget");
  std::vector<std::uint8_t> bytes(size);
  std::ifstream stream(path, std::ios::binary);
  stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
  require(stream.good() || (stream.eof() && stream.gcount() == static_cast<std::streamsize>(size)), "Native input read failed");
  return bytes;
}
static void write(const fs::path& path, const std::vector<std::uint8_t>& bytes) {
  require(bytes.size() <= FILE_LIMIT && !fs::exists(path), "Native output must be new and bounded");
  std::ofstream stream(path, std::ios::binary);
  stream.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  require(stream.good(), "Native output write failed");
}

template <typename Builder, typename Value>
static std::shared_ptr<arrow::Array> build(const fs::path& folder, const std::string& key,
                                         std::int64_t rows, bool nullable) {
  const auto physical = read(folder / (key + ".bin"));
  const auto validity = read(folder / (key + ".validity"));
  require(physical.size() == static_cast<std::size_t>(rows) * sizeof(Value) &&
          validity.size() == static_cast<std::size_t>(rows), "Original column length mismatch");
  Builder builder;
  check(builder.Reserve(rows));
  for (std::int64_t index = 0; index < rows; index++) {
    require(validity[index] <= 1, "Invalid original null mask");
    if (!validity[index]) {
      require(nullable, "Required original column contains null");
      check(builder.AppendNull());
    } else {
      Value value;
      std::memcpy(&value, physical.data() + index * sizeof(Value), sizeof(Value));
      check(builder.Append(value));
    }
  }
  std::shared_ptr<arrow::Array> result;
  check(builder.Finish(&result));
  return result;
}

static std::shared_ptr<arrow::Table> originals(const fs::path& folder, const std::string& keys,
                                              std::int64_t rows, bool nullable) {
  std::vector<std::shared_ptr<arrow::Array>> arrays;
  std::vector<std::shared_ptr<arrow::Field>> fields;
  for (char key : keys) {
    std::shared_ptr<arrow::Array> array;
    const std::string name(1, key);
    switch (key) {
      case 'b': array = build<arrow::BooleanBuilder, std::uint8_t>(folder, name, rows, nullable); break;
      case 'y': array = build<arrow::Int8Builder, std::int8_t>(folder, name, rows, nullable); break;
      case 's': array = build<arrow::Int16Builder, std::int16_t>(folder, name, rows, nullable); break;
      case 'i': array = build<arrow::Int32Builder, std::int32_t>(folder, name, rows, nullable); break;
      case 'q': array = build<arrow::Int64Builder, std::int64_t>(folder, name, rows, nullable); break;
      case 'f': array = build<arrow::FloatBuilder, float>(folder, name, rows, nullable); break;
      case 'd': array = build<arrow::DoubleBuilder, double>(folder, name, rows, nullable); break;
      default: throw std::runtime_error("Unknown original column key");
    }
    fields.push_back(arrow::field(name, array->type(), nullable));
    arrays.push_back(array);
  }
  return arrow::Table::Make(arrow::schema(fields), arrays, rows);
}

// Emit physical native values with null slots zeroed. Float NaN payloads are not an identity claim.
template <typename Array, typename Value>
static void emit(const std::shared_ptr<arrow::ChunkedArray>& column, const fs::path& folder,
                 const std::string& key) {
  std::vector<std::uint8_t> physical(column->length() * sizeof(Value), 0), validity(column->length(), 0);
  std::size_t index = 0;
  for (const auto& chunk : column->chunks()) {
    const auto& typed = static_cast<const Array&>(*chunk);
    for (std::int64_t at = 0; at < typed.length(); at++, index++) {
      if (typed.IsNull(at)) continue;
      validity[index] = 1;
      const Value value = typed.Value(at);
      std::memcpy(physical.data() + index * sizeof(Value), &value, sizeof(Value));
    }
  }
  write(folder / (key + ".bin"), physical);
  write(folder / (key + ".validity"), validity);
}
static void decoded(const std::shared_ptr<arrow::Table>& table, const fs::path& folder) {
  require(table->num_rows() <= 8192 && fs::create_directory(folder), "Decoded directory must be new and rows bounded");
  for (int index = 0; index < table->num_columns(); index++) {
    const auto column = table->column(index);
    const auto name = table->field(index)->name();
    require(name.size() == 1, "Unexpected native field name");
    switch (column->type()->id()) {
      case arrow::Type::BOOL: emit<arrow::BooleanArray, std::uint8_t>(column, folder, name); break;
      case arrow::Type::INT8: emit<arrow::Int8Array, std::int8_t>(column, folder, name); break;
      case arrow::Type::INT16: emit<arrow::Int16Array, std::int16_t>(column, folder, name); break;
      case arrow::Type::INT32: emit<arrow::Int32Array, std::int32_t>(column, folder, name); break;
      case arrow::Type::INT64: emit<arrow::Int64Array, std::int64_t>(column, folder, name); break;
      case arrow::Type::FLOAT: emit<arrow::FloatArray, float>(column, folder, name); break;
      case arrow::Type::DOUBLE: emit<arrow::DoubleArray, double>(column, folder, name); break;
      default: throw std::runtime_error("Unexpected native physical type");
    }
  }
  const auto schema = table->schema()->ToString();
  write(folder / "schema.txt", std::vector<std::uint8_t>(schema.begin(), schema.end()));
}

static void write_parquet(const fs::path& folder, std::int64_t rows, bool nullable,
                          int version, bool checksum, const std::string& profile) {
  const auto table = originals(folder, profile == "plain" ? "biqfd" : "i", rows, nullable);
  parquet::WriterProperties::Builder properties;
  properties.version(parquet::ParquetVersion::PARQUET_1_0)->data_page_version(
      version == 1 ? parquet::ParquetDataPageVersion::V1 : parquet::ParquetDataPageVersion::V2);
  properties.disable_dictionary()->disable_statistics()->encoding(parquet::Encoding::PLAIN);
  properties.compression(profile == "snappy" ? parquet::Compression::SNAPPY : parquet::Compression::UNCOMPRESSED);
  properties.data_pagesize(128)->write_batch_size(16);
  if (checksum) properties.enable_page_checksum();
  if (profile == "dictionary") properties.enable_dictionary();
  // ArrowWriterProperties defaults to not storing Arrow schema metadata, as in the frozen producer.
  auto sink = take(arrow::io::FileOutputStream::Open((folder / "native.parquet").string()));
  check(parquet::arrow::WriteTable(*table, arrow::default_memory_pool(), sink, rows > 33 ? 2048 : 9, properties.build()));
  check(sink->Close());
}
static void read_parquet(const fs::path& path, const fs::path& folder) {
  parquet::ReaderProperties properties;
  properties.set_page_checksum_verification(true);
  parquet::arrow::FileReaderBuilder builder;
  check(builder.OpenFile(path.string(), false, properties));
  auto reader = take(builder.Build());
  std::shared_ptr<arrow::Table> table;
  check(reader->ReadTable(&table));
  decoded(table, folder);
  auto raw = parquet::ParquetFileReader::OpenFile(path.string(), false, properties);
  auto metadata = raw->metadata();
  std::ofstream receipt(folder / "metadata.tsv");
  receipt << "rows\t" << metadata->num_rows() << '\n';
  for (int group_index = 0; group_index < metadata->num_row_groups(); group_index++) {
    auto group = metadata->RowGroup(group_index);
    receipt << "group\t" << group_index << '\t' << group->num_rows() << '\n';
    for (int column_index = 0; column_index < group->num_columns(); column_index++) {
      auto column = group->ColumnChunk(column_index);
      receipt << "column\t" << group_index << '\t' << column->path_in_schema()->ToDotString() << '\t'
              << static_cast<int>(column->compression()) << '\t' << column->num_values() << '\t'
              << column->data_page_offset() << '\t' << column->dictionary_page_offset() << '\t'
              << column->total_compressed_size() << '\t' << column->total_uncompressed_size() << '\t'
              << column->has_dictionary_page() << '\t';
      for (auto encoding : column->encodings()) receipt << parquet::EncodingToString(encoding) << ',';
      receipt << '\n';
    }
  }
  require(receipt.good(), "Parquet metadata output failed");
}
static void write_orc(const fs::path& folder, std::int64_t rows, int minor) {
  const auto table = originals(folder, "bysiqfd", rows, true);
  arrow::adapters::orc::WriteOptions options;
  options.file_version = arrow::adapters::orc::FileVersion(0, minor);
  options.compression = arrow::Compression::UNCOMPRESSED;
  options.stripe_size = 4096;
  options.batch_size = 256;
  options.row_index_stride = 1000;
  options.padding_tolerance = 0;
  options.dictionary_key_size_threshold = 0;
  auto sink = take(arrow::io::FileOutputStream::Open((folder / "native.orc").string()));
  auto writer = take(arrow::adapters::orc::ORCFileWriter::Open(sink.get(), options));
  check(writer->Write(*table)); check(writer->Close()); check(sink->Close());
}
static void read_orc(const fs::path& path, const fs::path& folder) {
  auto file = take(arrow::io::ReadableFile::Open(path.string()));
  auto reader = take(arrow::adapters::orc::ORCFileReader::Open(file, arrow::default_memory_pool()));
  auto table = take(reader->Read());
  decoded(table, folder);
  std::ofstream receipt(folder / "metadata.tsv");
  receipt << "rows\t" << reader->NumberOfRows() << "\nstripes\t" << reader->NumberOfStripes() << '\n';
  require(receipt.good(), "ORC metadata output failed");
}

int main(int argc, char** argv) {
  try {
    const std::uint16_t endian = 1;
    require(*reinterpret_cast<const std::uint8_t*>(&endian) == 1, "Native harness requires little-endian host");
    require(argc >= 5, "Expected read/write format path and output/options");
    const std::string action = argv[1], format = argv[2];
    if (action == "read") {
      require(argc == 5, "Read arguments mismatch");
      require(fs::is_regular_file(fs::symlink_status(argv[3])) && fs::file_size(argv[3]) <= FILE_LIMIT, "Native image is not admitted");
      if (format == "parquet") read_parquet(argv[3], argv[4]);
      else if (format == "orc") read_orc(argv[3], argv[4]);
      else throw std::runtime_error("Unknown native format");
    } else if (action == "write") {
      const auto rows = std::stoll(argv[4]);
      require(rows >= 0 && rows <= 8192, "Original row count exceeds budget");
      if (format == "parquet") {
        require(argc == 9, "Parquet write arguments mismatch");
        write_parquet(argv[3], rows, std::string(argv[5]) == "true", std::stoi(argv[6]), std::string(argv[7]) == "true", argv[8]);
      } else if (format == "orc") {
        require(argc == 6, "ORC write arguments mismatch");
        write_orc(argv[3], rows, std::stoi(argv[5]));
      } else throw std::runtime_error("Unknown native format");
    } else throw std::runtime_error("Unknown native action");
    return 0;
  } catch (const std::exception& failure) { std::cerr << failure.what() << '\n'; return 1; }
}
