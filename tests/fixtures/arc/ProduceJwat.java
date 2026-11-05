/* Test-only native JWAT writer and reader invocation. ARC framing is owned by JWAT. */
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.jwat.arc.*;

public class ProduceJwat {
    static void write(ArcWriter writer, ArcRecordBase record, String url, String type, byte[] block) throws Exception {
        record.header.urlStr = url;
        record.header.ipAddressStr = "192.0.2.1";
        record.header.archiveDateStr = "20260102030405";
        record.header.contentTypeStr = type;
        record.header.archiveLength = (long) block.length;
        writer.writeHeader(record);
        writer.writePayload(block);
        writer.closeRecord();
    }
    static void consume(Path path, Path directory, String prefix, boolean strict) throws Exception {
        try (InputStream input = Files.newInputStream(path); ArcReader reader = ArcReaderFactory.getReader(input,4096)) {
            reader.setStrict(strict);
            StringBuilder status = new StringBuilder();
            int index=0;
            ArcRecordBase record;
            while ((record=reader.getNextRecord()) != null) {
                byte[] block = record.getPayload() == null ? new byte[0] : record.getPayload().getInputStreamComplete().readAllBytes();
                Files.write(directory.resolve(prefix+index),block);
                record.close();
                System.out.println(prefix+index+" "+record.getUrlStr()+" "+block.length+" compliant="+record.isCompliant()+" errors="+record.diagnostics.getErrors()+" warnings="+record.diagnostics.getWarnings());
                status.append(index+" "+record.isCompliant()+" "+record.diagnostics.getErrors().size()+" "+record.diagnostics.getWarnings().size()+"\n");
                index++;
            }
            Files.writeString(directory.resolve(prefix+"status"),status);
            if (index!=5) throw new Exception("Independent JWAT consumer record count="+index);
        }
    }
    public static void main(String[] args) throws Exception {
        Path directory=Path.of(args[0]);
        try(OutputStream output=Files.newOutputStream(directory.resolve("jwat.arc")); ArcWriter writer=ArcWriterFactory.getWriter(output,false)) {
            ArcVersionHeader version=ArcVersionHeader.create(ArcVersion.VERSION_1,"OPFSFixture");
            version.rebuild();
            write(writer,ArcVersionBlock.createRecord(writer),"filedesc://jwat.arc","text/plain",version.getHeader());
            String[] urls={"http://example.test/capture","dns:example.test","http://example.test/capture","urn:example:empty"};
            String[] types={"text/plain","application/octet-stream","text/plain","application/octet-stream"};
            for(int i=0;i<4;i++) write(writer,ArcRecord.createRecord(writer),urls[i],types[i],Files.readAllBytes(directory.resolve("block"+i)));
        }
        consume(directory.resolve("jwat.arc"),directory,"jwat-output",true);
        consume(directory.resolve("genuine.arc"),directory,"iipc-output",false);
        consume(directory.resolve("genuine.arc"),directory,"iipc-strict-output",true);
    }
}
