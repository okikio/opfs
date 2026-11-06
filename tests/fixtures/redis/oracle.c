/* Test-only hiredis ABI recipe. The native library owns RESP framing and parsing.
 * The fixture fixes authority/database/credentials and bounds binary inputs. */
#define _POSIX_C_SOURCE 200809L
#include <hiredis/hiredis.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <unistd.h>
#define LIMIT 1048576
static unsigned char key[1024], value[LIMIT];
static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void base64(const unsigned char *bytes, size_t length) {
  for (size_t i = 0; i < length; i += 3) {
    uint32_t v = (uint32_t)bytes[i] << 16;
    if (i + 1 < length) v |= (uint32_t)bytes[i + 1] << 8;
    if (i + 2 < length) v |= bytes[i + 2];
    putchar(alphabet[v >> 18]); putchar(alphabet[(v >> 12) & 63]);
    putchar(i + 1 < length ? alphabet[(v >> 6) & 63] : '=');
    putchar(i + 2 < length ? alphabet[v & 63] : '=');
  }
}
static int load(const char *path, unsigned char *bytes, size_t cap, size_t *length) {
  /* Docker copies inputs; the SDK never needs a writable directory, symlink or FIFO. */
  int file = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (file < 0) return 0;
  struct stat info;
  if (fstat(file, &info) || !S_ISREG(info.st_mode) || info.st_size < 0 || (uintmax_t)info.st_size > cap) { close(file); return 0; }
  *length = (size_t)info.st_size;
  size_t at = 0;
  while (at < *length) {
    ssize_t count = read(file, bytes + at, *length - at);
    if (count <= 0) { close(file); return 0; }
    at += (size_t)count;
  }
  unsigned char extra;
  const ssize_t tail = read(file, &extra, 1);
  close(file);
  return tail == 0;
}
static int status(redisReply *reply, const char *expected) {
  int valid = reply && reply->type == REDIS_REPLY_STATUS && reply->len == strlen(expected) && memcmp(reply->str, expected, reply->len) == 0;
  if (reply) freeReplyObject(reply);
  return valid;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int init = strcmp(argv[1], "init") == 0, seed = strcmp(argv[1], "seed") == 0, read = strcmp(argv[1], "read") == 0;
  if (!init && !seed && !read) return 2;
  struct timeval timeout = {5, 0};
  redisContext *client = redisConnectWithTimeout("redis.test", 6379, timeout);
  if (!client) return 1;
  int result = 1;
  if (client->err || redisSetTimeout(client, timeout) != REDIS_OK) goto done;
  if (!status(redisCommand(client, "AUTH opfs fixture-only-redis"), "OK") || !status(redisCommand(client, "SELECT 3"), "OK")) goto done;
  if (init) {
    if (!status(redisCommand(client, "PING"), "PONG")) goto done;
    puts("RECEIPT:{\"native\":\"hiredis\",\"ping\":true}"); result = 0;
  } else {
    size_t key_length = 0, value_length = 0;
    if (!load("/oracle/key.bin", key, sizeof(key), &key_length)) goto done;
    if (seed) {
      if (!load("/oracle/value.bin", value, sizeof(value), &value_length)) goto done;
      if (!status(redisCommand(client, "SET %b %b", key, key_length, value, value_length), "OK")) goto done;
      puts("RECEIPT:{\"stored\":true}"); result = 0;
    } else {
      redisReply *reply = redisCommand(client, "GET %b", key, key_length);
      if (!reply || (reply->type != REDIS_REPLY_STRING && reply->type != REDIS_REPLY_NIL) || reply->len > LIMIT) { if (reply) freeReplyObject(reply); goto done; }
      redisReply *ttl = redisCommand(client, "PTTL %b", key, key_length);
      if (!ttl || ttl->type != REDIS_REPLY_INTEGER || ttl->integer < -2) { freeReplyObject(reply); if (ttl) freeReplyObject(ttl); goto done; }
      printf("RECEIPT:{\"missing\":%s,\"base64\":", reply->type == REDIS_REPLY_NIL ? "true" : "false");
      if (reply->type == REDIS_REPLY_NIL) fputs("null", stdout);
      else { putchar('"'); base64((const unsigned char *)reply->str, reply->len); putchar('"'); }
      printf(",\"ttl\":\"%lld\"}\n", ttl->integer);
      freeReplyObject(reply); freeReplyObject(ttl); result = 0;
    }
  }
done:
  redisFree(client);
  if (result) fputs("Native hiredis operation refused or failed\n", stderr);
  return result || ferror(stdout) ? 1 : 0;
}
