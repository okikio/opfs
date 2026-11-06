/* Authored SDK shim. rabbitmq-c owns every AMQP wire byte and decoded message. */
#include <amqp.h>
#include <amqp_framing.h>
#include <amqp_tcp_socket.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#define MAX_BODY 1048576

static int rpc(amqp_rpc_reply_t reply, const char *operation) {
  if (reply.reply_type == AMQP_RESPONSE_NORMAL) return 1;
  fprintf(stderr, "Native %s failed: response=%d library=%d method=%u\n", operation,
          reply.reply_type, reply.reply_type == AMQP_RESPONSE_LIBRARY_EXCEPTION ? reply.library_error : 0,
          reply.reply_type == AMQP_RESPONSE_SERVER_EXCEPTION ? reply.reply.id : 0);
  return 0;
}
static const amqp_field_value_t *field(const amqp_table_t *table, const char *key) {
  if (!table) return NULL;
  for (int index = 0; index < table->num_entries; index++) {
    const amqp_table_entry_t *entry = &table->entries[index];
    if (entry->key.len == strlen(key) && !memcmp(entry->key.bytes, key, entry->key.len)) return &entry->value;
  }
  return NULL;
}
static int version(amqp_connection_state_t connection) {
  const amqp_field_value_t *value = field(amqp_get_server_properties(connection), "version");
  return value && value->kind == AMQP_FIELD_KIND_UTF8 && value->value.bytes.len == 5 &&
         !memcmp(value->value.bytes.bytes, "4.4.0", 5);
}
static int capabilities(amqp_connection_state_t connection) {
  const amqp_field_value_t *table = field(amqp_get_server_properties(connection), "capabilities");
  if (!table || table->kind != AMQP_FIELD_KIND_TABLE) return 0;
  const amqp_field_value_t *confirm = field(&table->value.table, "publisher_confirms");
  return confirm && confirm->kind == AMQP_FIELD_KIND_BOOLEAN && confirm->value.boolean;
}
static void base64(amqp_bytes_t body) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const unsigned char *bytes = body.bytes;
  for (size_t at = 0; at < body.len; at += 3) {
    const size_t left = body.len - at;
    const uint32_t value = ((uint32_t)bytes[at] << 16) |
      (left > 1 ? (uint32_t)bytes[at + 1] << 8 : 0) | (left > 2 ? bytes[at + 2] : 0);
    putchar(alphabet[(value >> 18) & 63]); putchar(alphabet[(value >> 12) & 63]);
    putchar(left > 1 ? alphabet[(value >> 6) & 63] : '='); putchar(left > 2 ? alphabet[value & 63] : '=');
  }
}

static int initialize(amqp_connection_state_t connection) {
  amqp_exchange_declare(connection, 1, amqp_cstring_bytes("owned"), amqp_cstring_bytes("direct"), 0, 0, 0, 0, amqp_empty_table);
  if (!rpc(amqp_get_rpc_reply(connection), "exchange declare")) return 0;
  amqp_table_entry_t entries[2];
  entries[0].key = amqp_cstring_bytes("x-max-length-bytes"); entries[0].value.kind = AMQP_FIELD_KIND_I32; entries[0].value.value.i32 = MAX_BODY;
  entries[1].key = amqp_cstring_bytes("x-max-length"); entries[1].value.kind = AMQP_FIELD_KIND_I32; entries[1].value.value.i32 = 64;
  const amqp_table_t arguments = {2, entries};
  amqp_queue_declare(connection, 1, amqp_cstring_bytes("owned"), 0, 1, 0, 0, arguments);
  if (!rpc(amqp_get_rpc_reply(connection), "queue declare")) return 0;
  amqp_queue_bind(connection, 1, amqp_cstring_bytes("owned"), amqp_cstring_bytes("owned"), amqp_cstring_bytes("key"), amqp_empty_table);
  if (!rpc(amqp_get_rpc_reply(connection), "queue bind") || !version(connection) || !capabilities(connection)) return 0;
  printf("RECEIPT:{\"sdk\":\"rabbitmq-c %s\",\"serverVersion\":\"4.4.0\",\"publisherConfirms\":true}\n", amqp_version());
  return 1;
}
static int seed(amqp_connection_state_t connection) {
  int file = open("/oracle/value.bin", O_RDONLY | O_NOFOLLOW);
  struct stat info;
  if (file < 0 || fstat(file, &info) || !S_ISREG(info.st_mode) || info.st_size < 0 || info.st_size > MAX_BODY) { if (file >= 0) close(file); return 0; }
  const size_t length = (size_t)info.st_size;
  unsigned char *body = malloc(length ? length : 1);
  if (!body) { close(file); return 0; }
  size_t at = 0;
  while (at < length) { ssize_t count = read(file, body + at, length - at); if (count <= 0) { free(body); close(file); return 0; } at += count; }
  unsigned char extra;
  const ssize_t tail = read(file, &extra, 1); close(file);
  if (tail != 0) { free(body); return 0; }
  amqp_confirm_select(connection, 1);
  if (!rpc(amqp_get_rpc_reply(connection), "confirm select")) { free(body); return 0; }
  const amqp_bytes_t bytes = {length, body};
  const int status = amqp_basic_publish(connection, 1, amqp_cstring_bytes("owned"), amqp_cstring_bytes("key"), 1, 0, NULL, bytes);
  free(body);
  if (status != AMQP_STATUS_OK) return 0;
  struct timeval timeout = {5, 0};
  amqp_frame_t reply;
  // One publication starts at sequence 1. A return, nack, close or unrelated frame
  // cannot be converted into a successful receipt merely because bytes were sent.
  if (amqp_simple_wait_frame_noblock(connection, &reply, &timeout) != AMQP_STATUS_OK ||
      reply.frame_type != AMQP_FRAME_METHOD || reply.channel != 1 || reply.payload.method.id != AMQP_BASIC_ACK_METHOD) return 0;
  const amqp_basic_ack_t *ack = reply.payload.method.decoded;
  if (ack->delivery_tag != 1) return 0;
  printf("RECEIPT:{\"confirmed\":true,\"bytes\":%zu}\n", length);
  return 1;
}
static int take(amqp_connection_state_t connection) {
  const amqp_rpc_reply_t reply = amqp_basic_get(connection, 1, amqp_cstring_bytes("owned"), 1);
  if (!rpc(reply, "basic get")) return 0;
  if (reply.reply.id == AMQP_BASIC_GET_EMPTY_METHOD) { puts("RECEIPT:{\"empty\":true}"); return 1; }
  if (reply.reply.id != AMQP_BASIC_GET_OK_METHOD) return 0;
  const amqp_basic_get_ok_t *method = reply.reply.decoded;
  const uint64_t tag = method->delivery_tag;
  const uint32_t count = method->message_count;
  const int redelivered = method->redelivered;
  amqp_message_t message;
  if (!rpc(amqp_read_message(connection, 1, &message, 0), "read complete message")) return 0;
  if (message.body.len > MAX_BODY) { amqp_destroy_message(&message); return 0; }
  printf("RECEIPT:{\"empty\":false,\"deliveryTag\":\"%" PRIu64 "\",\"redelivered\":%s,\"messageCount\":\"%" PRIu32 "\",\"base64\":\"", tag, redelivered ? "true" : "false", count);
  base64(message.body); puts("\"}"); amqp_destroy_message(&message);
  return 1;
}
static int count(amqp_connection_state_t connection) {
  const amqp_queue_declare_ok_t *reply = amqp_queue_declare(connection, 1, amqp_cstring_bytes("owned"), 1, 0, 0, 0, amqp_empty_table);
  if (!rpc(amqp_get_rpc_reply(connection), "passive queue count") || !reply) return 0;
  printf("RECEIPT:{\"messages\":\"%" PRIu32 "\"}\n", reply->message_count);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  const char *operation = argv[1];
  if (strcmp(operation, "init") && strcmp(operation, "seed") && strcmp(operation, "take") && strcmp(operation, "count")) return 2;
  amqp_connection_state_t connection = amqp_new_connection();
  if (!connection) return 1;
  int success = 0, opened = 0, channel = 0;
  struct timeval timeout = {5, 0};
  amqp_socket_t *socket = amqp_tcp_socket_new(connection);
  if (!socket || amqp_set_handshake_timeout(connection, &timeout) != AMQP_STATUS_OK ||
      amqp_set_rpc_timeout(connection, &timeout) != AMQP_STATUS_OK ||
      amqp_socket_open_noblock(socket, "amqp.test", 5672, &timeout) != AMQP_STATUS_OK) goto cleanup;
  if (!rpc(amqp_login(connection, "/owned", 1, 65536, 60, AMQP_SASL_METHOD_PLAIN, "fixture", "fixture-only-amqp"), "login")) goto cleanup;
  opened = 1;
  amqp_channel_open(connection, 1);
  if (!rpc(amqp_get_rpc_reply(connection), "channel open")) goto cleanup;
  channel = 1;
  if (!version(connection)) goto cleanup;
  if (!strcmp(operation, "init")) success = initialize(connection);
  else if (!strcmp(operation, "seed")) success = seed(connection);
  else if (!strcmp(operation, "take")) success = take(connection);
  else success = count(connection);
cleanup:
  if (channel && !rpc(amqp_channel_close(connection, 1, AMQP_REPLY_SUCCESS), "channel close")) success = 0;
  if (opened && !rpc(amqp_connection_close(connection, AMQP_REPLY_SUCCESS), "connection close")) success = 0;
  if (amqp_destroy_connection(connection) != AMQP_STATUS_OK) success = 0;
  if (!success) fputs("Independent rabbitmq-c operation failed.\n", stderr);
  return success && !ferror(stdout) ? 0 : 1;
}
