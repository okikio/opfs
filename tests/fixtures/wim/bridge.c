/* Test-only adapter to wimlib's public compression API (wimlib.h v1.13.6).
 * No codec implementation is copied. Inputs, output and stack buffers are bounded.
 * argv: {compress|decompress} {1=XPRESS|2=LZX} decoded-size input-file
 * stdout is only native output. Every native failure returns nonzero.
 */
#include <wimlib.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv)
{
    unsigned char input[65536], output[32768];
    char *end;
    unsigned long expected;
    int type, status = 1, tail;
    size_t size, produced;
    FILE *file;
    struct wimlib_compressor *compressor = NULL;
    struct wimlib_decompressor *decompressor = NULL;
    if (argc != 5 || (strcmp(argv[1], "compress") && strcmp(argv[1], "decompress"))) return 2;
    type = !strcmp(argv[2], "1") ? 1 : !strcmp(argv[2], "2") ? 2 : 0;
    if (!type || !argv[3][0]) return 2;
    errno = 0; expected = strtoul(argv[3], &end, 10);
    if (errno || *end || expected == 0 || expected > sizeof(output)) return 2;
    file = fopen(argv[4], "rb");
    if (!file) return 3;
    size = fread(input, 1, sizeof(input), file);
    tail = fgetc(file);
    if (ferror(file) || tail != EOF) { fclose(file); return 4; }
    if (fclose(file) || size == 0) return 4;
    if (!strcmp(argv[1], "compress")) {
        if (size > 32768 || size != expected) return 4;
        if (wimlib_create_compressor((enum wimlib_compression_type)type, 32768, 50, &compressor)) goto done;
        produced = wimlib_compress(input, size, output, sizeof(output), compressor);
        if (!produced || produced > sizeof(output)) goto done;
    } else {
        if (wimlib_create_decompressor((enum wimlib_compression_type)type, 32768, &decompressor)) goto done;
        if (wimlib_decompress(input, size, output, expected, decompressor)) goto done;
        produced = expected;
    }
    if (fwrite(output, 1, produced, stdout) != produced || fflush(stdout)) goto done;
    status = 0;
done:
    wimlib_free_compressor(compressor);
    wimlib_free_decompressor(decompressor);
    if (status) fputs("Native wimlib compression API failed.\n", stderr);
    return status;
}
