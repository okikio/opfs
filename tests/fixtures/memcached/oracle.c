/* Test-only ABI shim: libmemcached owns all protocol serialization and parsing.
 * Fixed inputs bound allocations/output; no candidate code or C protocol parser is linked. */
#include <libmemcached/memcached.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define LIMIT 1048576
static unsigned char input[LIMIT];
static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void base64(const unsigned char *bytes, size_t length) {
  for (size_t i = 0; i < length; i += 3) {
    uint32_t value = (uint32_t)bytes[i] << 16;
    if (i + 1 < length) value |= (uint32_t)bytes[i + 1] << 8;
    if (i + 2 < length) value |= bytes[i + 2];
    putchar(alphabet[value >> 18]); putchar(alphabet[(value >> 12) & 63]);
    putchar(i + 1 < length ? alphabet[(value >> 6) & 63] : '='); putchar(i + 2 < length ? alphabet[value & 63] : '=');
  }
}
static int failure(memcached_st *client, const char *operation, memcached_return_t status) {
  fprintf(stderr, "%s: %s\n", operation, memcached_strerror(client, status)); return 1;
}
int main(int argc, char **argv) {
  if (argc < 2 || argc > 3) return 2;
  const int init = strcmp(argv[1], "init") == 0, seed = strcmp(argv[1], "seed") == 0, read = strcmp(argv[1], "read") == 0;
  if ((!init && !seed && !read) || (init ? argc != 2 : argc != 3)) return 2;
  size_t key_length = init ? 0 : strlen(argv[2]);
  if (!init) { if (!key_length || key_length > 250) return 2; for (size_t i = 0; i < key_length; i++) if ((unsigned char)argv[2][i] < 33 || (unsigned char)argv[2][i] > 126) return 2; }
  memcached_st *client = memcached_create(NULL); if (!client) return 1;
  int code = 1; memcached_return_t status;
#define CHECK(call) do { status = (call); if (status != MEMCACHED_SUCCESS) { failure(client, #call, status); goto done; } } while (0)
  CHECK(memcached_server_add(client, "memcached.test", 11211));
  CHECK(memcached_behavior_set(client, MEMCACHED_BEHAVIOR_BINARY_PROTOCOL, 0));
  CHECK(memcached_behavior_set(client, MEMCACHED_BEHAVIOR_NOREPLY, 0));
  CHECK(memcached_behavior_set(client, MEMCACHED_BEHAVIOR_SUPPORT_CAS, 1));
  CHECK(memcached_behavior_set(client, MEMCACHED_BEHAVIOR_CONNECT_TIMEOUT, 5000));
  CHECK(memcached_behavior_set(client, MEMCACHED_BEHAVIOR_POLL_TIMEOUT, 10000));
  CHECK(memcached_behavior_set(client, MEMCACHED_BEHAVIOR_SND_TIMEOUT, 10000000));
  CHECK(memcached_behavior_set(client, MEMCACHED_BEHAVIOR_RCV_TIMEOUT, 10000000));
  if (init) {
    memcached_stat_st *stats = memcached_stat(client, NULL, &status);
    if (!stats || status != MEMCACHED_SUCCESS) { if (stats) free(stats); failure(client, "stats", status); goto done; }
    char *version = memcached_stat_get_value(client, stats, "version", &status); free(stats);
    if (!version || status != MEMCACHED_SUCCESS) { free(version); failure(client, "version", status); goto done; }
    if (strcmp(version, "1.6.45") != 0) { free(version); fputs("Native server version mismatch\n", stderr); goto done; }
    printf("VERSION:%s\nLIBRARY:%s\n", version, memcached_lib_version()); free(version); code = 0;
  } else if (seed) {
    FILE *file = fopen("/oracle/input.bin", "rb"); if (!file) goto done;
    size_t size = fread(input, 1, LIMIT, file); int extra = fgetc(file), invalid = ferror(file); fclose(file);
    if (extra != EOF || invalid) { fputs("Input exceeds fixture bound\n", stderr); goto done; }
    CHECK(memcached_set(client, argv[2], key_length, (const char *)input, size, 0, UINT32_MAX));
    puts("STORED:true"); code = 0;
  } else {
    const char *keys[] = { argv[2] }; size_t lengths[] = { key_length };
    CHECK(memcached_mget(client, keys, lengths, 1));
    memcached_result_st *result = memcached_fetch_result(client, NULL, &status);
    if (!result) { if (status == MEMCACHED_END || status == MEMCACHED_NOTFOUND) { puts("MISSING:true"); code = 0; } else failure(client, "fetch", status); goto done; }
    if (status != MEMCACHED_SUCCESS || memcached_result_key_length(result) != key_length || memcmp(memcached_result_key_value(result), argv[2], key_length) != 0 || memcached_result_length(result) > LIMIT || memcached_result_cas(result) == 0) { memcached_result_free(result); fputs("Invalid native result\n", stderr); goto done; }
    fputs("BYTES:", stdout); base64((const unsigned char *)memcached_result_value(result), memcached_result_length(result));
    printf("\nCAS:%" PRIu64 "\nFLAGS:%" PRIu32 "\n", memcached_result_cas(result), memcached_result_flags(result));
    /* Reuse the result: its count distinguishes END after a value from NOTFOUND.
     * fetch_result retires an allocated result itself when it returns NULL. */
    result = memcached_fetch_result(client, result, &status);
    if (result) { memcached_result_free(result); fputs("Unexpected second result\n", stderr); goto done; }
    if (status != MEMCACHED_END) { failure(client, "terminal fetch", status); goto done; }
    code = 0;
  }
done:
  memcached_free(client); return code || ferror(stdout) ? 1 : 0;
}
