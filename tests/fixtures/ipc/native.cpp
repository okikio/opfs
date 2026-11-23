// Authored fixture harness. Arrow C++ owns both IPC encoding and decoding.
#include <arrow/api.h>
#include <arrow/io/api.h>
#include <arrow/ipc/api.h>
#include <fcntl.h>
#include <unistd.h>

#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using Bytes = std::vector<uint8_t>;
constexpr size_t kFileLimit = 1024 * 1024;

void require(bool value, const std::string& reason) {
  if (!value) throw std::runtime_error(reason);
}
void check(const arrow::Status& status) {
  if (!status.ok()) throw std::runtime_error(status.ToString());
}
template <typename T> T take(arrow::Result<T> result) {
  check(result.status());
  return std::move(result).ValueUnsafe();
}
Bytes read(const fs::path& path, size_t expected) {
  require(fs::is_regular_file(fs::symlink_status(path)), "Input is not a regular file");
  require(expected <= kFileLimit && fs::file_size(path) == expected, "Input length differs");
  Bytes bytes(expected);
  std::ifstream stream(path, std::ios::binary);
  if (expected) stream.read(reinterpret_cast<char*>(bytes.data()), expected);
  require(bool(stream), "Input read failed");
  return bytes;
}
// Exclusive creation prevents a new qualification from replacing old evidence.
void write(const fs::path& path, const Bytes& bytes) {
  require(bytes.size() <= kFileLimit, "Output exceeds fixture budget");
  int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
  require(fd >= 0, "Output must be new");
  size_t at = 0;
  while (at < bytes.size()) {
    ssize_t count = ::write(fd, bytes.data() + at, bytes.size() - at);
    if (count <= 0) {
      ::close(fd);
      throw std::runtime_error("Output write failed");
    }
    at += static_cast<size_t>(count);
  }
  require(::close(fd) == 0, "Output close failed");
}
template <typename T> T value(const Bytes& bytes, size_t row) {
  T output;
  std::memcpy(&output, bytes.data() + row * sizeof(T), sizeof(T));
  return output;
}
template <typename T> void append(Bytes& bytes, T item) {
  const auto* start = reinterpret_cast<const uint8_t*>(&item);
  bytes.insert(bytes.end(), start, start + sizeof(T));
}
std::shared_ptr<arrow::Schema> schema() {
  return arrow::schema({arrow::field("i", arrow::int32()), arrow::field("q", arrow::int64()),
    arrow::field("d", arrow::float64()), arrow::field("b", arrow::boolean()),
    arrow::field("s", arrow::utf8()), arrow::field("x", arrow::binary())});
}
template <typename Builder, typename T>
std::shared_ptr<arrow::Array> fixed(const fs::path& folder, const std::string& key, int rows) {
  auto mask = read(folder / (key + ".validity"), rows);
  auto data = read(folder / (key + ".bin"), rows * sizeof(T));
  Builder builder;
  check(builder.Reserve(rows));
  for (int row = 0; row < rows; ++row) {
    require(mask[row] <= 1, "Invalid validity byte");
    if (mask[row]) {
      if (key == "b") require(data[row] <= 1, "Invalid boolean byte");
      check(builder.Append(value<T>(data, row)));
    } else check(builder.AppendNull());
  }
  return take(builder.Finish());
}
template <typename Builder>
std::shared_ptr<arrow::Array> variable(const fs::path& folder, const std::string& key, int rows) {
  auto mask = read(folder / (key + ".validity"), rows);
  auto offsets = read(folder / (key + ".offsets"), (rows + 1) * sizeof(int32_t));
  int32_t end = value<int32_t>(offsets, rows);
  require(end >= 0 && static_cast<size_t>(end) <= kFileLimit, "Invalid final offset");
  auto data = read(folder / (key + ".data"), end);
  require(value<int32_t>(offsets, 0) == 0, "First offset must be zero");
  Builder builder;
  for (int row = 0; row < rows; ++row) {
    int32_t first = value<int32_t>(offsets, row), last = value<int32_t>(offsets, row + 1);
    require(mask[row] <= 1 && first >= 0 && last >= first && last <= end, "Invalid variable row");
    if (!mask[row]) {
      require(first == last, "Null variable row must be empty");
      check(builder.AppendNull());
    } else {
      const char* start = last == first ? "" : reinterpret_cast<const char*>(data.data() + first);
      check(builder.Append(start, last - first));
    }
  }
  return take(builder.Finish());
}
std::shared_ptr<arrow::RecordBatch> batch(const fs::path& folder, int rows) {
  auto result = arrow::RecordBatch::Make(schema(), rows, {
    fixed<arrow::Int32Builder, int32_t>(folder, "i", rows),
    fixed<arrow::Int64Builder, int64_t>(folder, "q", rows),
    fixed<arrow::DoubleBuilder, double>(folder, "d", rows),
    fixed<arrow::BooleanBuilder, uint8_t>(folder, "b", rows),
    variable<arrow::StringBuilder>(folder, "s", rows),
    variable<arrow::BinaryBuilder>(folder, "x", rows)});
  check(result->ValidateFull());
  return result;
}
// Null slots are canonical zero. Validity remains separate, so empty and null differ.
void retain(const fs::path& folder, const arrow::RecordBatch& batch) {
  require(fs::create_directory(folder), "Decoded batch folder must be new");
  check(batch.ValidateFull());
  require(batch.schema()->Equals(*schema(), true), "Readback schema differs");
  for (int column = 0; column < batch.num_columns(); ++column) {
    auto array = batch.column(column);
    const std::string key = schema()->field(column)->name();
    Bytes mask, data, offsets;
    if (column >= 4) append<int32_t>(offsets, 0);
    for (int64_t row = 0; row < batch.num_rows(); ++row) {
      bool valid = !array->IsNull(row);
      mask.push_back(valid ? 1 : 0);
      switch (column) {
        case 0: append<int32_t>(data, valid ? static_cast<const arrow::Int32Array&>(*array).Value(row) : 0); break;
        case 1: append<int64_t>(data, valid ? static_cast<const arrow::Int64Array&>(*array).Value(row) : 0); break;
        case 2: append<double>(data, valid ? static_cast<const arrow::DoubleArray&>(*array).Value(row) : 0); break;
        case 3: data.push_back(valid && static_cast<const arrow::BooleanArray&>(*array).Value(row) ? 1 : 0); break;
        default: {
          if (valid) {
            auto view = column == 4
              ? static_cast<const arrow::StringArray&>(*array).GetView(row)
              : static_cast<const arrow::BinaryArray&>(*array).GetView(row);
            data.insert(data.end(), view.begin(), view.end());
          }
          append<int32_t>(offsets, static_cast<int32_t>(data.size()));
        }
      }
    }
    write(folder / (key + ".validity"), mask);
    write(folder / (key + (column >= 4 ? ".data" : ".bin")), data);
    if (column >= 4) write(folder / (key + ".offsets"), offsets);
  }
}
int main(int argc, char** argv) {
  try {
    uint16_t endian = 1;
    require(*reinterpret_cast<uint8_t*>(&endian) == 1, "Only little-endian qualification hosts supported");
    require(argc >= 3 && argc <= 6, "Usage: native file|stream folder [rows ...]");
    std::string format = argv[1];
    require(format == "file" || format == "stream", "Unknown IPC format");
    fs::path folder = argv[2];
    std::vector<std::shared_ptr<arrow::RecordBatch>> batches;
    for (int index = 3; index < argc; ++index) {
      std::string text = argv[index];
      require(!text.empty() && text.size() <= 2 &&
        text.find_first_not_of("0123456789") == std::string::npos, "Invalid row count");
      int rows = std::stoi(text);
      require(rows <= 64, "Fixture row limit exceeded");
      batches.push_back(batch(folder / ("batch-" + std::to_string(index - 3)), rows));
    }
    fs::path image = folder / (format == "file" ? "native.arrow" : "native.arrows");
    write(image, {}); // Reserve a fresh path before Arrow opens our owned file.
    auto sink = take(arrow::io::FileOutputStream::Open(image.string()));
    auto options = arrow::ipc::IpcWriteOptions::Defaults();
    options.metadata_version = arrow::ipc::MetadataVersion::V5;
    options.write_legacy_ipc_format = false;
    options.use_threads = false;
    options.codec.reset();
    auto writer = take(format == "file" ? arrow::ipc::MakeFileWriter(sink, schema(), options)
                                        : arrow::ipc::MakeStreamWriter(sink, schema(), options));
    for (const auto& item : batches) check(writer->WriteRecordBatch(*item));
    check(writer->Close());
    check(sink->Close());
    require(fs::file_size(image) <= kFileLimit, "IPC image exceeds fixture budget");
    auto input = take(arrow::io::ReadableFile::Open(image.string()));
    auto decoded = folder / "decoded";
    require(fs::create_directory(decoded), "Decoded folder must be new");
    size_t count = 0;
    auto accept = [&](const std::shared_ptr<arrow::RecordBatch>& actual) {
      require(count < batches.size(), "Unexpected readback batch");
      require(actual->num_rows() == batches[count]->num_rows(), "Readback row count differs");
      retain(decoded / ("batch-" + std::to_string(count)), *actual);
      ++count;
    };
    if (format == "file") {
      auto reader = take(arrow::ipc::RecordBatchFileReader::Open(input));
      require(reader->schema()->Equals(*schema(), true), "File schema differs");
      require(reader->version() == arrow::ipc::MetadataVersion::V5, "File metadata version differs");
      for (int index = 0; index < reader->num_record_batches(); ++index) accept(take(reader->ReadRecordBatch(index)));
    } else {
      auto reader = take(arrow::ipc::RecordBatchStreamReader::Open(input));
      require(reader->schema()->Equals(*schema(), true), "Stream schema differs");
      while (auto actual = take(reader->Next())) accept(actual);
      require(take(input->Tell()) == static_cast<int64_t>(fs::file_size(image)),
        "Stream readback left trailing bytes");
    }
    require(count == batches.size(), "Missing readback batch");
    check(input->Close());
    std::cout << "Arrow C++ IPC V5 full readback: " << format << " " << count << " batches\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
