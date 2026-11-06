// Independent official libnats JetStream operations. No OPFS parser/client code.
#include <nats/nats.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
void require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
void status(natsStatus value) { if(value!=NATS_OK) throw std::runtime_error(natsStatus_GetText(value)); }
// Encode exact binary messages for a bounded JSON receipt; never interpret UTF-8.
std::string base64(const char* bytes,int count) {
  require(count>=0 && count<=1048576,"native message byte ceiling");
  const char* table="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output; output.reserve((count+2)/3*4);
  for(int at=0;at<count;at+=3) {
    const auto a=static_cast<unsigned char>(bytes[at]);
    const auto b=at+1<count?static_cast<unsigned char>(bytes[at+1]):0;
    const auto c=at+2<count?static_cast<unsigned char>(bytes[at+2]):0;
    output+=table[a>>2]; output+=table[((a&3)<<4)|(b>>4)];
    output+=at+1<count?table[((b&15)<<2)|(c>>6)]:'='; output+=at+2<count?table[c&63]:'=';
  }
  return output;
}
int main(int argc,char** argv) {
  natsOptions* options=nullptr; natsConnection* connection=nullptr; jsCtx* context=nullptr;
  try {
    require(argc>=2 && argc<=3,"usage: oracle init|seed|read|other [sequence]");
    status(natsOptions_Create(&options)); status(natsOptions_SetURL(options,"nats://nats.test:4222"));
    status(natsOptions_SetUserInfo(options,"oracle","fixture-only-oracle"));
    status(natsOptions_SetTimeout(options,5000)); status(natsOptions_SetAllowReconnect(options,false));
    status(natsOptions_SetMaxReconnect(options,0)); status(natsConnection_Connect(&connection,options));
    jsOptions settings; status(jsOptions_Init(&settings)); settings.Wait=5000;
    status(natsConnection_JetStream(&context,connection,&settings));
    const std::string operation=argv[1];
    if(operation=="init") {
      const char* names[]={"OWNED","OTHER"}; const char* subjects[]={"owned.data","other.data"};
      for(int index=0;index<2;index++) {
        jsStreamConfig config; status(jsStreamConfig_Init(&config));
        config.Name=names[index]; config.Subjects=&subjects[index]; config.SubjectsLen=1;
        config.Storage=js_MemoryStorage; config.MaxBytes=4194304; config.MaxMsgs=64; config.MaxMsgSize=1048576;
        jsStreamInfo* info=nullptr; status(js_AddStream(&info,context,&config,nullptr,nullptr)); jsStreamInfo_Destroy(info);
      }
      const std::string version=nats_GetVersion();
      require(version.size()<=64 && version.find_first_not_of("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-_")==std::string::npos,"native SDK version receipt");
      std::cout<<"RECEIPT:{\"sdk\":\"nats.c\",\"version\":\""<<version<<"\"}\n";
    } else if(operation=="seed") {
      const auto count=std::filesystem::file_size("/oracle/value.bin"); require(count<=1048576,"native seed byte ceiling");
      std::vector<char> bytes(count); std::ifstream file("/oracle/value.bin",std::ios::binary);
      require(bool(file.read(bytes.data(),count)),"native seed read");
      jsPubAck* ack=nullptr; status(js_Publish(&ack,context,"owned.data",bytes.data(),bytes.size(),nullptr,nullptr));
      require(ack && ack->Stream && std::string(ack->Stream)=="OWNED","native publish stream");
      std::cout<<"RECEIPT:{\"stream\":\"OWNED\",\"sequence\":\""<<ack->Sequence<<"\",\"duplicate\":"<<(ack->Duplicate?"true":"false")<<"}\n";
      jsPubAck_Destroy(ack);
    } else if(operation=="read") {
      require(argc==3,"native read sequence required"); const std::string sequence=argv[2];
      require(!sequence.empty() && sequence.size()<=20 && sequence[0]!='0' && sequence.find_first_not_of("0123456789")==std::string::npos,"canonical native sequence");
      const uint64_t number=std::stoull(sequence); natsMsg* message=nullptr;
      status(js_GetMsg(&message,context,"OWNED",number,nullptr,nullptr));
      require(message && natsMsg_GetSequence(message)==number && std::string(natsMsg_GetSubject(message))=="owned.data","native get identity");
      const auto encoded=base64(natsMsg_GetData(message),natsMsg_GetDataLength(message));
      std::cout<<"RECEIPT:{\"subject\":\"owned.data\",\"sequence\":\""<<number<<"\",\"base64\":\""<<encoded<<"\"}\n";
      natsMsg_Destroy(message);
    } else if(operation=="other") {
      jsStreamInfo* info=nullptr; status(js_GetStreamInfo(&info,context,"OTHER",nullptr,nullptr));
      require(info,"native stream state"); std::cout<<"RECEIPT:{\"messages\":\""<<info->State.Msgs<<"\"}\n"; jsStreamInfo_Destroy(info);
    } else throw std::runtime_error("unsupported independent native operation");
    jsCtx_Destroy(context); natsConnection_Destroy(connection); natsOptions_Destroy(options); nats_Close(); return 0;
  } catch(const std::exception& error) {
    std::cerr<<error.what()<<"\n"; jsCtx_Destroy(context); natsConnection_Destroy(connection); natsOptions_Destroy(options); nats_Close(); return 1;
  }
}
