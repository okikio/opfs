/* Authored test-only reciprocal CFITSIO producer/consumer. No upstream source. */
#include <fitsio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  fitsfile *f = NULL; int status = 0;
  if (argc != 4) return 2;
  if (!strcmp(argv[1], "write")) {
    char path[4096]; snprintf(path, sizeof(path), "!%s", argv[2]);
    long axes[] = {3, 2}; short values[] = {-32768, -7, 0, 1, 7, 32767};
    fits_create_file(&f, path, &status);
    fits_create_img(f, SHORT_IMG, 2, axes, &status);
    fits_write_img(f, TSHORT, 1, 6, values, &status);
    fits_write_chksum(f, &status);
    long axis = 3; LONGLONG exact[] = {-9007199254740993LL, 9007199254740993LL, 9223372036854775807LL};
    fits_create_img(f, LONGLONG_IMG, 1, &axis, &status);
    fits_write_img(f, TLONGLONG, 1, 3, exact, &status);
    fits_write_chksum(f, &status);
  } else {
    fits_open_file(&f, argv[2], READONLY, &status);
    int count = 0; fits_get_num_hdus(f, &count, &status);
    for (int i = 1; i <= count && !status; i++) {
      int type = 0, bitpix = 0, ndim = 0; long axes[16];
      fits_movabs_hdu(f, i, &type, &status);
      if (type != IMAGE_HDU) continue;
      fits_get_img_param(f, 16, &bitpix, &ndim, axes, &status);
      LONGLONG pixels = ndim ? 1 : 0;
      for (int j = 0; j < ndim; j++) pixels *= axes[j];
      int datatype = bitpix == 8 ? TBYTE : bitpix == 16 ? TSHORT : bitpix == 32 ? TINT : bitpix == 64 ? TLONGLONG : bitpix == -32 ? TFLOAT : TDOUBLE;
      size_t width = abs(bitpix) / 8;
      if (bitpix != 64) {
        double *physical = calloc(pixels ? (size_t)pixels : 1, sizeof(double));
        int anynul = 0;
        if (pixels) fits_read_img(f, TDOUBLE, 1, pixels, NULL, physical, &anynul, &status);
        char output[4096]; snprintf(output, sizeof(output), "%s/%d.physical", argv[3], i - 1);
        FILE *out = fopen(output, "wb"); if (!out) return 3;
        fwrite(physical, sizeof(double), (size_t)pixels, out); fclose(out); free(physical);
      }
      void *values = calloc(pixels ? (size_t)pixels : 1, width);
      fits_set_bscale(f, 1, 0, &status);
      int anynul = 0;
      if (pixels) fits_read_img(f, datatype, 1, pixels, NULL, values, &anynul, &status);
      char output[4096]; snprintf(output, sizeof(output), "%s/%d.bin", argv[3], i - 1);
      FILE *out = fopen(output, "wb"); if (!out) return 3;
      fwrite(values, width, (size_t)pixels, out); fclose(out); free(values);
      int dataok = 0, hduok = 0; fits_verify_chksum(f, &dataok, &hduok, &status);
      printf("%d %d %d\n", i - 1, dataok, hduok);
    }
  }
  if (f) fits_close_file(f, &status);
  if (status) fits_report_error(stderr, status);
  return status ? 1 : 0;
}
