// Candidate-free MCAP 2.2.0 NONE writer and native sequential/seeking readers.
// CRC authentication belongs to the separate Node-zlib framing verifier: the
// pinned native C++ reader does not validate CRCs. Never report native refusal.
#define MCAP_IMPLEMENTATION
#define MCAP_COMPRESSION_NO_LZ4
#define MCAP_COMPRESSION_NO_ZSTD
#include <mcap/reader.hpp>
#include <mcap/writer.hpp>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

static void require(bool yes, const char* message) {
  if (!yes) throw std::runtime_error(message);
}
static void status(const mcap::Status& value) {
  if (!value.ok()) throw std::runtime_error(value.message);
}
static mcap::ByteArray bytes(const std::string& value) {
  return {reinterpret_cast<const std::byte*>(value.data()), reinterpret_cast<const std::byte*>(value.data() + value.size())};
}
static const auto schemaData = bytes(std::string("\0schema\xff", 8));
static const auto attachmentData = bytes(std::string("\0native attachment\xff", 19));
static const std::string schemaName = "literal\xef\xbb\xbf" "schema";
static const std::string topic = "topic/\xef\xbb\xbf" "literal";
static const mcap::KeyValueMap channelMetadata{{"owner", "caller"}, {"name", "e\xcc\x81"}};
static const mcap::KeyValueMap namedMetadata{{"a", "one"}, {"b", "two"}};
static mcap::ByteArray original(size_t i) {
  mcap::ByteArray result(17 + i * 29);
  for (size_t j = 0; j < result.size(); ++j) result[j] = std::byte((j * 31 + i * 17) % 251);
  return result;
}
static void schema(const mcap::Schema& value) {
  require(value.name == schemaName && value.encoding == "opaque" && value.data == schemaData, "Native schema differs from complete authored original");
}
static void channel(const mcap::Channel& value) {
  require(value.topic == topic && value.messageEncoding == "binary" && value.metadata == channelMetadata, "Native channel metadata differs");
}
static void message(const mcap::Message& value, size_t index, mcap::ChannelId id) {
  require(index < 7, "Unexpected extra native message");
  const auto expected = original(index);
  const uint64_t timestamp = (uint64_t(1) << 63) + index * 1001;
  require(value.channelId == id && value.sequence == index % 3 && value.logTime == timestamp && value.publishTime == timestamp + 1, "Native uint64 timestamp/sequence/channel differs");
  require(value.dataSize == expected.size() && std::equal(expected.begin(), expected.end(), value.data), "Native full message bytes differ");
}
static void attachment(const mcap::Attachment& value) {
  require(value.name == "literal/../attachment" && value.mediaType == "application/octet-stream" && value.logTime == 123 && value.createTime == 456, "Native attachment fields differ");
  require(value.dataSize == attachmentData.size() && std::equal(attachmentData.begin(), attachmentData.end(), value.data), "Native full attachment bytes differ");
}
static void metadata(const mcap::Metadata& value) {
  require(value.name == "metadata" && value.metadata == namedMetadata, "Native named metadata differs");
}
static void one(const std::filesystem::path& root, const std::string& mode) {
  const auto path = (root / (mode + ".mcap")).string();
  const bool empty = mode == "empty";
  mcap::McapWriter writer;
  mcap::McapWriterOptions options("opfs-fixture");
  options.library = "native-mcap-cpp-2.2.0";
  options.compression = mcap::Compression::None;
  options.chunkSize = 160;
  options.noChunking = mode != "chunked";
  options.enableDataCRC = true;
  options.noSummary = mode == "zero-summary";
  status(writer.open(path, options));
  mcap::ChannelId id = 0;
  if (!empty) {
    mcap::Schema definition(schemaName, "opaque", schemaData);
    writer.addSchema(definition);
    mcap::Channel publication(topic, "binary", definition.id, channelMetadata);
    writer.addChannel(publication);
    id = publication.id;
    for (size_t i = 0; i < 7; ++i) {
      const auto payload = original(i);
      mcap::Message value{};
      value.channelId = id;
      value.sequence = i % 3;
      value.logTime = (uint64_t(1) << 63) + i * 1001;
      value.publishTime = value.logTime + 1;
      value.data = payload.data();
      value.dataSize = payload.size();
      status(writer.write(value));
    }
    mcap::Attachment value{};
    value.logTime = 123;
    value.createTime = 456;
    value.name = "literal/../attachment";
    value.mediaType = "application/octet-stream";
    value.data = attachmentData.data();
    value.dataSize = attachmentData.size();
    status(writer.write(value));
    status(writer.write(mcap::Metadata{"metadata", namedMetadata}));
  }
  writer.close();
  const auto size = std::filesystem::file_size(path);
  require(size >= 37 && size <= 256 * 1024, "Native fixture file extent");
  {
    mcap::McapReader reader;
    status(reader.open(path));
    size_t messages = 0, schemas = 0, channels = 0, attachments = 0, records = 0;
    size_t metadatas = 0;
    // This explicit native record path expands uncompressed chunks and also
    // visits summary repetitions. Every callback compares borrowed bytes now.
    mcap::TypedRecordReader scan(*reader.dataSource(), 8, size - 8);
    scan.onSchema = [&](const mcap::SchemaPtr value, auto, auto) { schema(*value); ++schemas; };
    scan.onChannel = [&](const mcap::ChannelPtr value, auto, auto) { channel(*value); ++channels; };
    scan.onMessage = [&](const mcap::Message& value, auto, auto) { message(value, messages++, id); };
    scan.onAttachment = [&](const mcap::Attachment& value, auto) { attachment(value); ++attachments; };
    scan.onMetadata = [&](const mcap::Metadata& value, auto) { metadata(value); ++metadatas; };
    while (scan.next()) require(++records <= 256, "Native record callback ceiling");
    status(scan.status());
    require(messages == (empty ? 0 : 7) && attachments == (empty ? 0 : 1) && metadatas == (empty ? 0 : 1), "Native sequential inventory differs");
    require(empty ? schemas == 0 && channels == 0 : schemas > 0 && channels > 0, "Native sequential definitions missing");
  }
  {
    mcap::McapReader reader;
    status(reader.open(path));
    // Missing summaries deliberately use the project's native fallback scan.
    status(reader.readSummary(mcap::ReadSummaryMethod::AllowFallbackScan, status));
    mcap::ReadMessageOptions selection;
    selection.readOrder = mode == "chunked" ? mcap::ReadMessageOptions::ReadOrder::LogTimeOrder : mcap::ReadMessageOptions::ReadOrder::FileOrder;
    auto view = reader.readMessages(status, selection);
    size_t messages = 0;
    for (const auto& value : view) {
      require(value.schema && value.channel, "Native seeking definitions missing");
      schema(*value.schema);
      channel(*value.channel);
      message(value.message, messages++, id);
    }
    status(view.status());
    require(messages == (empty ? 0 : 7), "Native seeking inventory differs");
    size_t attachments = 0, metadatas = 0;
    for (const auto& entry : reader.attachmentIndexes()) {
      mcap::Record record;
      status(mcap::McapReader::ReadRecord(*reader.dataSource(), entry.second.offset, &record));
      mcap::Attachment value;
      status(mcap::McapReader::ParseAttachment(record, &value));
      attachment(value);
      ++attachments;
    }
    for (const auto& entry : reader.metadataIndexes()) {
      mcap::Record record;
      status(mcap::McapReader::ReadRecord(*reader.dataSource(), entry.second.offset, &record));
      mcap::Metadata value;
      status(mcap::McapReader::ParseMetadata(record, &value));
      metadata(value);
      ++metadatas;
    }
    require(attachments == (empty ? 0 : 1) && metadatas == (empty ? 0 : 1), "Native indexed/fallback attachment/metadata inventory differs");
  }
  std::cout << mode << ": native writer/sequential/seeking original-byte checks passed; native reader CRC validation unavailable\n";
}
int main(int argc, char** argv) {
  try {
    require(argc == 2 && std::filesystem::is_directory(argv[1]), "Usage: native OWNED_FRESH_DIRECTORY");
    for (const auto* mode : {"chunked", "unchunked", "zero-summary", "empty"}) one(argv[1], mode);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
