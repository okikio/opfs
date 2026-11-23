/*
 * Authored fixture-only HDF5 API writer/consumer. No upstream implementation.
 *
 * TypeScript supplies fixed raw inputs and a small manifest. Using the same
 * explicit file datatype as the memory datatype preserves their exact endian
 * and NaN bit patterns. HDF5 and h5dump share a library; they are separate API
 * paths, not independently implemented format parsers.
 *
 * This short-lived child fails on the first error. Its parent owns the complete
 * temporary tree, including any partially written output after native failure.
 */
#define H5_USE_110_API
#include <hdf5.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_BYTES (16 * 1024 * 1024)

typedef struct {
  char name[64];
  char dtype[8];
  int rank;
  hsize_t shape[2];
} dataset_spec;

static void fail(const char *message) {
  fprintf(stderr, "HDF5 fixture: %s\n", message);
  H5Eprint2(H5E_DEFAULT, stderr);
  exit(1);
}

static hid_t require_id(hid_t id, const char *message) {
  if (id < 0) fail(message);
  return id;
}

static void require_status(herr_t status, const char *message) {
  if (status < 0) fail(message);
}

/* Paths contain only authored manifest names inside the parent's owned tree. */
static void path_join(char *output, size_t capacity, const char *directory, const char *name) {
  int size = snprintf(output, capacity, "%s/%s", directory, name);
  if (size < 0 || (size_t)size >= capacity) fail("path exceeds native buffer");
}

static hid_t datatype(const char *dtype) {
  if (!strcmp(dtype, "<i1")) return H5T_STD_I8LE;
  if (!strcmp(dtype, "<u1")) return H5T_STD_U8LE;
  if (!strcmp(dtype, "<i2")) return H5T_STD_I16LE;
  if (!strcmp(dtype, ">i2")) return H5T_STD_I16BE;
  if (!strcmp(dtype, "<u2")) return H5T_STD_U16LE;
  if (!strcmp(dtype, ">u2")) return H5T_STD_U16BE;
  if (!strcmp(dtype, "<i4")) return H5T_STD_I32LE;
  if (!strcmp(dtype, ">i4")) return H5T_STD_I32BE;
  if (!strcmp(dtype, "<u4")) return H5T_STD_U32LE;
  if (!strcmp(dtype, ">u4")) return H5T_STD_U32BE;
  if (!strcmp(dtype, "<i8")) return H5T_STD_I64LE;
  if (!strcmp(dtype, ">i8")) return H5T_STD_I64BE;
  if (!strcmp(dtype, "<u8")) return H5T_STD_U64LE;
  if (!strcmp(dtype, ">u8")) return H5T_STD_U64BE;
  if (!strcmp(dtype, "<f4")) return H5T_IEEE_F32LE;
  if (!strcmp(dtype, ">f4")) return H5T_IEEE_F32BE;
  if (!strcmp(dtype, "<f8")) return H5T_IEEE_F64LE;
  if (!strcmp(dtype, ">f8")) return H5T_IEEE_F64BE;
  fail("manifest contains an unsupported datatype");
  return -1;
}

static size_t elements(const dataset_spec *spec) {
  size_t count = 1;
  for (int axis = 0; axis < spec->rank; axis++) {
    if (spec->shape[axis] > MAX_BYTES || (spec->shape[axis] && count > MAX_BYTES / spec->shape[axis])) fail("shape exceeds workload budget");
    count *= (size_t)spec->shape[axis];
  }
  return count;
}

/* The manifest is an authored control language, never a general file importer. */
static int next_spec(FILE *input, dataset_spec *spec) {
  char line[256], tail;
  unsigned long long first, second;
  if (!fgets(line, sizeof(line), input)) {
    if (ferror(input)) fail("cannot read manifest");
    return 0;
  }
  if (!strchr(line, '\n')) fail("manifest line exceeds profile");
  if (sscanf(line, "%63s %7s %d %llu %llu %c", spec->name, spec->dtype, &spec->rank, &first, &second, &tail) != 5) fail("malformed manifest row");
  if (strspn(spec->name, "abcdefghijklmnopqrstuvwxyz0123456789_") != strlen(spec->name)) fail("manifest name is not admitted");
  if (spec->rank < 0 || spec->rank > 2) fail("manifest rank is not admitted");
  spec->shape[0] = (hsize_t)first;
  spec->shape[1] = (hsize_t)second;
  datatype(spec->dtype);
  return 1;
}

static FILE *manifest(const char *inputs) {
  char path[4096];
  path_join(path, sizeof(path), inputs, "manifest.tsv");
  FILE *file = fopen(path, "rb");
  if (!file) fail("cannot open manifest");
  return file;
}

static void read_original(const char *inputs, const dataset_spec *spec, unsigned char *data, size_t bytes) {
  char path[4096], name[80];
  snprintf(name, sizeof(name), "%s.bin", spec->name);
  path_join(path, sizeof(path), inputs, name);
  FILE *file = fopen(path, "rb");
  if (!file) fail("cannot open original byte input");
  if (fread(data, 1, bytes, file) != bytes || fgetc(file) != EOF || ferror(file)) fail("original input size differs from manifest");
  if (fclose(file)) fail("cannot close original input");
}

static void write_bytes(const char *directory, const char *name, const unsigned char *data, size_t bytes) {
  char path[4096];
  path_join(path, sizeof(path), directory, name);
  FILE *file = fopen(path, "wb");
  if (!file) fail("cannot open native byte output");
  if (fwrite(data, 1, bytes, file) != bytes || fclose(file)) fail("cannot finish native byte output");
}

static hid_t dataspace(const dataset_spec *spec) {
  return require_id(spec->rank ? H5Screate_simple(spec->rank, spec->shape, NULL) : H5Screate(H5S_SCALAR), "cannot create dataspace");
}

static void write_dataset(hid_t file, const dataset_spec *spec, const unsigned char *data, int chunked, int filtered) {
  hid_t space = dataspace(spec);
  hid_t properties = require_id(H5Pcreate(H5P_DATASET_CREATE), "cannot create dataset properties");
  require_status(H5Pset_obj_track_times(properties, 0), "cannot disable dataset timestamps");
  if (chunked) {
    hsize_t chunk = 64;
    require_status(H5Pset_chunk(properties, 1, &chunk), "cannot set chunk shape");
  }
  if (filtered) require_status(H5Pset_deflate(properties, 4), "cannot enable native deflate filter");
  hid_t dataset = require_id(H5Dcreate2(file, spec->name, datatype(spec->dtype), space, H5P_DEFAULT, properties, H5P_DEFAULT), "cannot create dataset");
  if (data && elements(spec)) require_status(H5Dwrite(dataset, datatype(spec->dtype), H5S_ALL, H5S_ALL, H5P_DEFAULT, data), "cannot write original bytes");
  require_status(H5Dclose(dataset), "cannot close dataset");
  require_status(H5Pclose(properties), "cannot close dataset properties");
  require_status(H5Sclose(space), "cannot close dataspace");
}

static void write_profile(const char *profile, const char *path, const char *inputs) {
  hid_t access = require_id(H5Pcreate(H5P_FILE_ACCESS), "cannot create file access properties");
  require_status(H5Pset_libver_bounds(access, !strcmp(profile, "latest") ? H5F_LIBVER_LATEST : H5F_LIBVER_EARLIEST, H5F_LIBVER_LATEST), "cannot set format bounds");
  hid_t creation = require_id(H5Pcreate(H5P_FILE_CREATE), "cannot create file creation properties");
  if (!strcmp(profile, "userblock")) require_status(H5Pset_userblock(creation, 512), "cannot set userblock");
  hid_t file = require_id(H5Fcreate(path, H5F_ACC_EXCL, creation, access), "cannot create fresh HDF5 file");
  if (!strcmp(profile, "classic")) {
    FILE *list = manifest(inputs);
    dataset_spec spec;
    while (next_spec(list, &spec)) {
      size_t bytes = elements(&spec) * H5Tget_size(datatype(spec.dtype));
      if (bytes > MAX_BYTES) fail("original bytes exceed budget");
      unsigned char *data = calloc(bytes ? bytes : 1, 1);
      if (!data) fail("cannot allocate original bytes");
      read_original(inputs, &spec, data, bytes);
      write_dataset(file, &spec, data, 0, 0);
      free(data);
    }
    if (fclose(list)) fail("cannot close manifest");
    require_status(H5Lcreate_hard(file, "i32_le", file, "alias", H5P_DEFAULT, H5P_DEFAULT), "cannot create hard alias");
    require_status(H5Lcreate_soft("/i32_le", file, "soft", H5P_DEFAULT, H5P_DEFAULT), "cannot create soft link");
    hid_t group = require_id(H5Gcreate2(file, "nested", H5P_DEFAULT, H5P_DEFAULT, H5P_DEFAULT), "cannot create subgroup");
    dataset_spec child = {"child", "<i4", 1, {1, 0}};
    const unsigned char nine[4] = {9, 0, 0, 0};
    write_dataset(group, &child, nine, 0, 0);
    require_status(H5Gclose(group), "cannot close subgroup");
  } else if (!strcmp(profile, "large-tree")) {
    for (unsigned int index = 0; index < 400; index++) {
      dataset_spec spec = {"", "<i4", 1, {1, 0}};
      snprintf(spec.name, sizeof(spec.name), "v%04u", index);
      unsigned char data[4] = {(unsigned char)index, (unsigned char)(index >> 8), 0, 0};
      write_dataset(file, &spec, data, 0, 0);
    }
  } else if (!strcmp(profile, "compound")) {
    hid_t compound = require_id(H5Tcreate(H5T_COMPOUND, 4), "cannot create compound type");
    require_status(H5Tinsert(compound, "a", 0, H5T_STD_I16LE), "cannot insert compound member");
    require_status(H5Tinsert(compound, "b", 2, H5T_STD_I16LE), "cannot insert compound member");
    hsize_t one = 1;
    hid_t space = require_id(H5Screate_simple(1, &one, NULL), "cannot create compound space");
    hid_t properties = require_id(H5Pcreate(H5P_DATASET_CREATE), "cannot create compound properties");
    require_status(H5Pset_obj_track_times(properties, 0), "cannot disable compound timestamps");
    hid_t dataset = require_id(H5Dcreate2(file, "data", compound, space, H5P_DEFAULT, properties, H5P_DEFAULT), "cannot create compound dataset");
    const unsigned char pair[4] = {1, 0, 2, 0};
    require_status(H5Dwrite(dataset, compound, H5S_ALL, H5S_ALL, H5P_DEFAULT, pair), "cannot write compound values");
    require_status(H5Dclose(dataset), "cannot close compound dataset");
    require_status(H5Pclose(properties), "cannot close compound properties");
    require_status(H5Sclose(space), "cannot close compound space");
    require_status(H5Tclose(compound), "cannot close compound type");
  } else {
    if (strcmp(profile, "latest") && strcmp(profile, "chunked") && strcmp(profile, "filtered") && strcmp(profile, "unallocated") && strcmp(profile, "userblock")) fail("unknown profile");
    dataset_spec spec = {"data", "<i4", 1, {1000, 0}};
    unsigned char data[4000];
    for (unsigned int index = 0; index < 1000; index++) {
      data[index * 4] = (unsigned char)index;
      data[index * 4 + 1] = (unsigned char)(index >> 8);
      data[index * 4 + 2] = data[index * 4 + 3] = 0;
    }
    write_dataset(file, &spec, !strcmp(profile, "unallocated") ? NULL : data, !strcmp(profile, "chunked") || !strcmp(profile, "filtered"), !strcmp(profile, "filtered"));
  }
  require_status(H5Fclose(file), "cannot close produced file");
  require_status(H5Pclose(creation), "cannot close file creation properties");
  require_status(H5Pclose(access), "cannot close file access properties");
}

static herr_t root_link(hid_t file, const char *name, const H5L_info_t *info, void *unused) {
  (void)unused;
  if (info->type == H5L_TYPE_HARD) printf("LINK\t%s\tHardLink\t-\n", name);
  else if (info->type == H5L_TYPE_SOFT) {
    char target[256];
    if (info->u.val_size >= sizeof(target)) fail("soft link exceeds profile");
    require_status(H5Lget_val(file, name, target, sizeof(target), H5P_DEFAULT), "cannot read soft link");
    target[sizeof(target) - 1] = 0;
    printf("LINK\t%s\tSoftLink\t%s\n", name, target);
  } else fail("unexpected link kind");
  return 0;
}

/* Selected native reads use coordinates, not a slice of the complete dump. */
static void read_dataset(hid_t file, const dataset_spec *spec, const char *output) {
  hid_t dataset = require_id(H5Dopen2(file, spec->name, H5P_DEFAULT), "cannot open dataset");
  hid_t type = require_id(H5Dget_type(dataset), "cannot inspect datatype");
  if (H5Tequal(type, datatype(spec->dtype)) <= 0) fail("native datatype differs from authored manifest");
  hid_t space = require_id(H5Dget_space(dataset), "cannot inspect dataspace");
  if (H5Sget_simple_extent_ndims(space) != spec->rank) fail("native rank differs from authored manifest");
  hsize_t shape[2];
  if (spec->rank && H5Sget_simple_extent_dims(space, shape, NULL) < 0) fail("cannot read shape");
  for (int axis = 0; axis < spec->rank; axis++) if (shape[axis] != spec->shape[axis]) fail("native shape differs from authored manifest");
  size_t count = elements(spec), width = H5Tget_size(type), bytes = count * width;
  if (bytes > MAX_BYTES) fail("native dataset exceeds budget");
  unsigned char *data = calloc(bytes ? bytes : 1, 1);
  if (!data) fail("cannot allocate native bytes");
  if (count) require_status(H5Dread(dataset, type, H5S_ALL, H5S_ALL, H5P_DEFAULT, data), "cannot read native bytes");
  char name[96];
  snprintf(name, sizeof(name), "%s.bin", spec->name);
  write_bytes(output, name, data, bytes);
  free(data);
  size_t begin = count > 7 ? count - 7 : 0;
  size_t selected = count - begin < 5 ? count - begin : 5;
  unsigned char small[5 * 8] = {0};
  if (selected) {
    if (!spec->rank) require_status(H5Dread(dataset, type, H5S_ALL, H5S_ALL, H5P_DEFAULT, small), "cannot read selected scalar");
    else {
      hsize_t coordinates[5 * 2];
      for (size_t index = 0; index < selected; index++) {
        size_t flat = begin + index;
        if (spec->rank == 1) coordinates[index] = flat;
        else { coordinates[index * 2] = flat / spec->shape[1]; coordinates[index * 2 + 1] = flat % spec->shape[1]; }
      }
      require_status(H5Sselect_elements(space, H5S_SELECT_SET, selected, coordinates), "cannot select native coordinates");
      hsize_t length = selected;
      hid_t memory = require_id(H5Screate_simple(1, &length, NULL), "cannot create selection memory space");
      require_status(H5Dread(dataset, type, memory, space, H5P_DEFAULT, small), "cannot read selected native bytes");
      require_status(H5Sclose(memory), "cannot close selection memory space");
    }
  }
  snprintf(name, sizeof(name), "%s.selected", spec->name);
  write_bytes(output, name, small, selected * width);
  H5O_info_t info;
  require_status(H5Oget_info(dataset, &info), "cannot inspect object address");
  haddr_t address = H5Dget_offset(dataset);
  printf("DATA\t%s\t%llu\t", spec->name, (unsigned long long)info.addr);
  if (address == HADDR_UNDEF) printf("-"); else printf("%llu", (unsigned long long)address);
  printf("\t%llu\n", (unsigned long long)H5Dget_storage_size(dataset));
  require_status(H5Sclose(space), "cannot close native space");
  require_status(H5Tclose(type), "cannot close native datatype");
  require_status(H5Dclose(dataset), "cannot close native dataset");
}

static void read_classic(const char *path, const char *inputs, const char *output) {
  hid_t file = require_id(H5Fopen(path, H5F_ACC_RDONLY, H5P_DEFAULT), "cannot open classic file");
  FILE *list = manifest(inputs);
  dataset_spec spec;
  while (next_spec(list, &spec)) read_dataset(file, &spec, output);
  if (fclose(list)) fail("cannot close manifest");
  hsize_t index = 0;
  require_status(H5Literate(file, H5_INDEX_NAME, H5_ITER_INC, &index, root_link, NULL), "cannot inspect root links");
  H5O_info_t original, alias;
  require_status(H5Oget_info_by_name(file, "i32_le", &original, H5P_DEFAULT), "cannot inspect alias target");
  require_status(H5Oget_info_by_name(file, "alias", &alias, H5P_DEFAULT), "cannot inspect hard alias");
  if (original.addr != alias.addr) fail("hard alias does not identify original object");
  hid_t child = require_id(H5Dopen2(file, "nested/child", H5P_DEFAULT), "cannot open nested child");
  unsigned char nine[4];
  require_status(H5Dread(child, H5T_STD_I32LE, H5S_ALL, H5S_ALL, H5P_DEFAULT, nine), "cannot read nested child");
  const unsigned char expected[4] = {9, 0, 0, 0};
  if (memcmp(nine, expected, 4)) fail("nested child bytes differ");
  require_status(H5Dclose(child), "cannot close nested child");
  puts("STRUCTURE\thard-alias-and-nested-child-verified");
  require_status(H5Fclose(file), "cannot close consumed file");
}

int main(int argc, char **argv) {
  if (argc != 5) { fprintf(stderr, "usage: native write PROFILE FILE INPUTS | native read FILE INPUTS OUTPUTS\n"); return 2; }
  if (!strcmp(argv[1], "write")) write_profile(argv[2], argv[3], argv[4]);
  else if (!strcmp(argv[1], "read")) read_classic(argv[2], argv[3], argv[4]);
  else return 2;
  return 0;
}
