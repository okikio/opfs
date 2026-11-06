// Candidate-free GDAL writer/readback and direct libtiff block consumer.
// Inputs are authored little-endian sample bits. No Python bindings or candidate code.
#include <gdal_priv.h>
#include <ogr_spatialref.h>
#include <cpl_conv.h>
#include <cpl_string.h>
#include <tiffio.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
namespace fs = std::filesystem;
void require(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }
std::vector<unsigned char> read(const fs::path& path) {
  const auto count = fs::file_size(path);
  require(count <= 1024 * 1024, "native input byte ceiling");
  std::vector<unsigned char> bytes(count);
  std::ifstream file(path, std::ios::binary);
  require(bool(file.read(reinterpret_cast<char*>(bytes.data()), bytes.size())), "native input read");
  return bytes;
}
void write(const fs::path& path, const std::vector<unsigned char>& bytes) {
  require(bytes.size() <= 1024 * 1024, "native output byte ceiling");
  require(!fs::exists(path), "native output must be new");
  std::ofstream file(path, std::ios::binary);
  file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  require(bool(file), "native output write");
}
struct Profile { const char* name; GDALDataType type; bool tiled, big; int channels; bool overview, authored; };
const Profile profiles[] = {
  {"u16-strips-le",GDT_UInt16,false,false,1,false,false},
  {"u16-tiles-be",GDT_UInt16,true,true,1,false,false},
  {"rgb-u8-tiles",GDT_Byte,true,false,3,false,false},
  {"i16-strips",GDT_Int16,false,false,1,false,false},
  {"u32-strips",GDT_UInt32,false,true,1,false,false},
  {"i32-strips",GDT_Int32,false,false,1,false,false},
  {"f32-tiles",GDT_Float32,true,false,1,false,false},
  {"f64-strips-be",GDT_Float64,false,true,1,false,false},
  {"u16-main-chain-overview",GDT_UInt16,false,false,1,true,false},
  {"authored-tiles",GDT_UInt16,true,true,1,false,true},
  {"authored-strips",GDT_UInt16,false,true,1,false,true}
};
// The planar-band API uses explicit byte strides so RGB remains pixel interleaved.
void raster(GDALDataset* dataset, const Profile& profile, int page, std::vector<unsigned char>& bytes,
            GDALRWFlag mode, int x, int y, int width, int height) {
  const int scalar = GDALGetDataTypeSizeBytes(profile.type);
  require(bytes.size() == size_t(width * height * profile.channels * scalar), "native raster extent");
  for (int channel = 0; channel < profile.channels; channel++) {
    GDALRasterBand* band = dataset->GetRasterBand(channel + 1);
    require(band != nullptr, "native raster band");
    if (page) { require(band->GetOverviewCount() == 1, "native overview inventory"); band = band->GetOverview(0); }
    require(band && band->GetRasterDataType() == profile.type && band->GetXSize() == (page ? 10 : 19) &&
            band->GetYSize() == (page ? 9 : 17), "native scalar type and page geometry");
    require(band->RasterIO(mode,x,y,width,height,bytes.data()+channel*scalar,width,height,profile.type,
                           scalar*profile.channels,width*scalar*profile.channels,nullptr) == CE_None,
            "native raster IO");
  }
}
void inspect(const fs::path& root, const Profile& profile) {
  const auto path = root / (std::string(profile.name) + ".tif");
  GDALDataset* dataset = static_cast<GDALDataset*>(GDALOpen(path.c_str(),GA_ReadOnly));
  require(dataset && dataset->GetRasterXSize()==19 && dataset->GetRasterYSize()==17 &&
          dataset->GetRasterCount()==profile.channels,"native dataset geometry");
  const char* projection = dataset->GetProjectionRef();
  require(projection && std::strlen(projection)<=8192,"native projection bound");
  write(root/(std::string(profile.name)+".projection"),std::vector<unsigned char>(projection,projection+std::strlen(projection)));
  double transform[6]{};
  require(dataset->GetGeoTransform(transform)==CE_None,"native geotransform");
  std::vector<unsigned char> geo(sizeof(transform)); std::memcpy(geo.data(),transform,sizeof(transform));
  write(root/(std::string(profile.name)+".geotransform"),geo);
  const char* area=dataset->GetMetadataItem("AREA_OR_POINT");
  require(area && std::strlen(area)<=32,"native area/point metadata");
  write(root/(std::string(profile.name)+".area"),std::vector<unsigned char>(area,area+std::strlen(area)));
  TIFF* tiff=TIFFOpen(path.c_str(),"r"); require(tiff,"libtiff open");
  const int pages=profile.overview?2:1;
  require(TIFFNumberOfDirectories(tiff)==pages,"native IFD inventory");
  for(int page=0;page<pages;page++) {
    const int width=page?10:19,height=page?9:17,scalar=GDALGetDataTypeSizeBytes(profile.type);
    auto expected=read(root/(std::string(profile.name)+".page"+std::to_string(page)+".original"));
    std::vector<unsigned char> decoded(expected.size());
    raster(dataset,profile,page,decoded,GF_Read,0,0,width,height);
    require(decoded==expected,"GDAL full sample bits");
    const auto prefix=std::string(profile.name)+".page"+std::to_string(page);
    write(root/(prefix+".gdal"),decoded);
    const int ww=std::min(3,width),hh=std::min(2,height),x=width-ww,y=height-hh;
    std::vector<unsigned char> window(ww*hh*profile.channels*scalar),want;
    raster(dataset,profile,page,window,GF_Read,x,y,ww,hh);
    for(int row=y;row<height;row++) {
      const auto begin=expected.begin()+(row*width+x)*profile.channels*scalar;
      want.insert(want.end(),begin,begin+ww*profile.channels*scalar);
    }
    require(window==want,"GDAL bottom-right window bits"); write(root/(prefix+".window"),window);
    require(TIFFSetDirectory(tiff,page),"libtiff directory select");
    const bool tiled=TIFFIsTiled(tiff)!=0;
    const uint32_t count=tiled?TIFFNumberOfTiles(tiff):TIFFNumberOfStrips(tiff);
    require(count>0 && count<=256,"libtiff block inventory");
    for(uint32_t block=0;block<count;block++) {
      const auto extent=TIFFGetStrileByteCount(tiff,block);
      require(extent>0 && extent<=1024*1024,"libtiff block extent");
      std::vector<unsigned char> raw(extent),native(extent);
      const auto rawCount=tiled?TIFFReadRawTile(tiff,block,raw.data(),extent):TIFFReadRawStrip(tiff,block,raw.data(),extent);
      const auto decodedCount=tiled?TIFFReadEncodedTile(tiff,block,native.data(),extent):TIFFReadEncodedStrip(tiff,block,native.data(),extent);
      require(rawCount==static_cast<tmsize_t>(extent) && decodedCount==static_cast<tmsize_t>(extent),"libtiff complete block read");
      const auto blockPrefix=prefix+".block"+std::to_string(block);
      write(root/(blockPrefix+".raw"),raw); write(root/(blockPrefix+".decoded"),native);
    }
  }
  TIFFClose(tiff); GDALClose(dataset);
}
int main(int argc,char** argv) {
  try {
    require(argc==2,"usage: native-geotiff WORK_DIRECTORY");
    const uint16_t endian=1; require(*reinterpret_cast<const unsigned char*>(&endian)==1,"little-endian native host required");
    const fs::path root=argv[1]; require(fs::is_directory(root),"owned work directory required");
    CPLSetConfigOption("GDAL_CACHEMAX","32"); CPLSetConfigOption("GDAL_NUM_THREADS","1");
    CPLSetConfigOption("PROJ_NETWORK","OFF"); CPLSetConfigOption("GDAL_PAM_ENABLED","NO");
    GDALAllRegister(); GDALDriver* driver=GetGDALDriverManager()->GetDriverByName("GTiff"); require(driver,"GTiff driver");
    for(const auto& profile:profiles) {
      const auto path=root/(std::string(profile.name)+".tif");
      if(!profile.authored) {
        require(!fs::exists(path),"new native TIFF required"); char** options=nullptr;
        options=CSLSetNameValue(options,"BIGTIFF","NO"); options=CSLSetNameValue(options,"COMPRESS","NONE");
        options=CSLSetNameValue(options,"INTERLEAVE","PIXEL");
        options=CSLSetNameValue(options,"ENDIANNESS",profile.big?"BIG":"LITTLE");
        options=CSLSetNameValue(options,"TILED",profile.tiled?"YES":"NO");
        options=CSLSetNameValue(options,"BLOCKYSIZE",profile.tiled?"16":"2");
        if(profile.tiled) options=CSLSetNameValue(options,"BLOCKXSIZE","16");
        GDALDataset* dataset=driver->Create(path.c_str(),19,17,profile.channels,profile.type,options); CSLDestroy(options);
        require(dataset,"GTiff create"); OGRSpatialReference reference;
        require(reference.importFromEPSG(4326)==OGRERR_NONE && dataset->SetSpatialRef(&reference)==CE_None,"WGS84 reference");
        double transform[]={100,.5,0,50,0,-.5}; require(dataset->SetGeoTransform(transform)==CE_None,"geotransform set");
        require(dataset->SetMetadataItem("AREA_OR_POINT",std::string(profile.name)=="u16-tiles-be"?"Point":"Area")==CE_None,"area/point set");
        auto original=read(root/(std::string(profile.name)+".page0.original"));
        raster(dataset,profile,0,original,GF_Write,0,0,19,17);
        if(profile.overview) { const int factor=2; require(GDALBuildOverviews(dataset,"NEAREST",1,&factor,0,nullptr,nullptr,nullptr)==CE_None,"overview build"); }
        GDALClose(dataset);
      }
      inspect(root,profile);
    }
    std::cout<<"GDAL "<<GDALVersionInfo("RELEASE_NAME")<<"\n"<<TIFFGetVersion()<<"\n";
    GDALDestroyDriverManager(); return 0;
  } catch(const std::exception& error) { std::cerr<<error.what()<<"\n"; return 1; }
}
