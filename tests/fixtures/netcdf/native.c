/* Authored fixture-only netCDF-C producer and full native-byte consumer. */
#include <netcdf.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(call) do { int status = (call); if (status) { fprintf(stderr, "%s: %s\n", #call, nc_strerror(status)); return 1; } } while (0)
int main(int argc, char **argv) {
  if (argc != 5) return 2;
  int id;
  if (!strcmp(argv[1], "write")) {
    CHECK(nc_create(argv[2], NC_CLOBBER | (atoi(argv[3]) == 2 ? NC_64BIT_OFFSET : 0), &id));
    int time, three, two; CHECK(nc_def_dim(id, "time", NC_UNLIMITED, &time)); CHECK(nc_def_dim(id, "three", 3, &three)); CHECK(nc_def_dim(id, "two", 2, &two));
    if (!strcmp(argv[4], "single-byte") || !strcmp(argv[4], "single-char") || !strcmp(argv[4], "single-short") || !strcmp(argv[4], "empty")) {
      int variable, dims[] = {time, three};
      nc_type type = !strcmp(argv[4], "single-short") ? NC_SHORT : !strcmp(argv[4], "single-char") ? NC_CHAR : NC_BYTE;
      CHECK(nc_def_var(id, "record", type, 2, dims, &variable)); CHECK(nc_enddef(id));
      if (strcmp(argv[4], "empty")) {
        size_t start[] = {0,0}, count[] = {3,3}; signed char bytes[] = {0,1,2,3,4,5,6,7,8}; short shorts[] = {0,1,2,3,4,5,6,7,8};
        if (type == NC_BYTE) { CHECK(nc_put_vara_schar(id, variable, start, count, bytes)); }
        else if (type == NC_CHAR) { CHECK(nc_put_vara_text(id, variable, start, count, (char *)bytes)); }
        else { CHECK(nc_put_vara_short(id, variable, start, count, shorts)); }
      }
      CHECK(nc_close(id)); puts(nc_inq_libvers()); return 0;
    }
    int dims[] = {two, three}, recdims[] = {time, three}, vars[7];
    const char *names[] = {"bytes", "characters", "shorts", "integers", "floats", "doubles"};
    for (int type = 1; type <= 6; type++) CHECK(nc_def_var(id, names[type-1], type, 2, dims, &vars[type-1]));
    CHECK(nc_def_var(id, "records", NC_SHORT, 2, recdims, &vars[6]));
    int scalar; CHECK(nc_def_var(id, "scalar", NC_DOUBLE, 0, NULL, &scalar));
    short fill = -999, missing[] = {-777, -888}; float scale = 0.5f, offset = 10;
    CHECK(nc_put_att_short(id, vars[6], "_FillValue", NC_SHORT, 1, &fill));
    CHECK(nc_put_att_short(id, vars[6], "missing_value", NC_SHORT, 2, missing));
    CHECK(nc_put_att_float(id, vars[6], "scale_factor", NC_FLOAT, 1, &scale)); CHECK(nc_put_att_float(id, vars[6], "add_offset", NC_FLOAT, 1, &offset));
    CHECK(nc_put_att_text(id, vars[6], "units", 1, "K"));
    CHECK(nc_enddef(id));
    signed char bytes[] = {-128, -127, -1, 0, 1, 127}; char chars[] = {0, 1, 65, 127, (char)128, (char)255};
    short shorts[] = {-32768,-32767,-1,0,1,32767}; int ints[] = {-2147483647-1,-2147483647,-1,0,1,2147483647};
    float floats[] = {-0.0f,1.25f,-1.25f,0,3.5f,9.9692099683868690e36f}; double doubles[] = {-0.0,1.25,-1.25,0,3.5,9.9692099683868690e36};
    CHECK(nc_put_var_schar(id, vars[0], bytes)); CHECK(nc_put_var_text(id, vars[1], chars)); CHECK(nc_put_var_short(id, vars[2], shorts)); CHECK(nc_put_var_int(id, vars[3], ints)); CHECK(nc_put_var_float(id, vars[4], floats)); CHECK(nc_put_var_double(id, vars[5], doubles));
    short records[] = {-999,1,2,3,-777,5,6,7,-888}; size_t start[] = {0,0}, count[] = {3,3}; CHECK(nc_put_vara_short(id, vars[6], start, count, records));
    double value = 2.5; CHECK(nc_put_var_double(id, scalar, &value));
  } else {
    CHECK(nc_open(argv[2], NC_NOWRITE, &id));
    int variables; CHECK(nc_inq_nvars(id, &variables));
    for (int var = 0; var < variables; var++) {
      nc_type type; int rank, dims[NC_MAX_VAR_DIMS]; CHECK(nc_inq_var(id, var, NULL, &type, &rank, dims, NULL));
      size_t elements = 1, width = 0, shape[NC_MAX_VAR_DIMS]; CHECK(nc_inq_type(id, type, NULL, &width));
      for (int axis = 0; axis < rank; axis++) { CHECK(nc_inq_dimlen(id, dims[axis], &shape[axis])); elements *= shape[axis]; }
      void *values = calloc(elements ? elements : 1, width); CHECK(nc_get_var(id, var, values));
      char path[4096]; snprintf(path, sizeof(path), "%s/%d.bin", argv[4], var); FILE *out = fopen(path, "wb"); if (!out) return 3;
      fwrite(values, width, elements, out); fclose(out); free(values);
      int unlimited; CHECK(nc_inq_unlimdim(id, &unlimited));
      if (rank && dims[0] == unlimited && shape[0] >= 3) {
        size_t start[NC_MAX_VAR_DIMS] = {0}, count[NC_MAX_VAR_DIMS]; elements = 2; start[0] = 1; count[0] = 2;
        for (int axis = 1; axis < rank; axis++) { count[axis] = shape[axis]; elements *= shape[axis]; }
        values = calloc(elements, width); CHECK(nc_get_vara(id, var, start, count, values));
        snprintf(path, sizeof(path), "%s/%d.subset", argv[4], var); out = fopen(path, "wb"); if (!out) return 3;
        fwrite(values, width, elements, out); fclose(out); free(values);
      }
    }
  }
  CHECK(nc_close(id)); puts(nc_inq_libvers()); return 0;
}
