/* Test-only invocation of the independent IIPC ARC writer; no ARC encoding is implemented here. */
import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.archive.io.WriterPoolSettings;
import org.archive.io.arc.ARCWriter;

public class Produce {
    public static void main(String[] args) throws Exception {
        Path directory = Path.of(args[0]);
        WriterPoolSettings settings = new WriterPoolSettings() {
            public long getMaxFileSizeBytes() { return 1024 * 1024; }
            public String getPrefix() { return "fixture"; }
            public String getTemplate() { return "${prefix}-${timestamp17}-${serialno}"; }
            public List<File> calcOutputDirs() { return List.of(directory.toFile()); }
            public boolean getCompress() { return false; }
            public List<String> getMetadata() { return null; }
            public boolean getFrequentFlushes() { return false; }
            public int getWriteBufferSize() { return 4096; }
        };
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (PrintStream stream = new PrintStream(output);
             ARCWriter writer = new ARCWriter(new AtomicInteger(), stream, directory.resolve("fixture.arc").toFile(), settings)) {
            String[] urls = {"http://example.test/capture", "dns:example.test", "http://example.test/capture", "urn:example:empty"};
            String[] types = {"text/plain", "application/octet-stream", "text/plain", "application/octet-stream"};
            long date = Instant.parse("2026-01-02T03:04:05Z").toEpochMilli();
            for (int index = 0; index < urls.length; index++) {
                byte[] block = Files.readAllBytes(directory.resolve("block" + index));
                writer.write(urls[index], types[index], "192.0.2.1", date, block.length, new ByteArrayInputStream(block));
            }
        }
        Files.write(directory.resolve("genuine.arc"), output.toByteArray());
    }
}
