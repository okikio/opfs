import java.util.zip.CRC32C;

/** Source-only bounded JDK checksum reference; no Kafka or project imports. */
public final class CrcOracle {
    public static void main(String[] args) throws Exception {
        if (args.length != 0) throw new IllegalArgumentException("No arguments");
        CRC32C whole = new CRC32C();
        CRC32C split = new CRC32C();
        byte[] bytes = new byte[4096];
        int total = 0;
        for (int count; (count = System.in.read(bytes)) != -1;) {
            total = Math.addExact(total, count);
            if (total > 4 * 1024 * 1024) throw new IllegalArgumentException("Input extent");
            whole.update(bytes, 0, count);
            int half = count / 2;
            split.update(bytes, 0, half);
            split.update(bytes, half, count - half);
        }
        if (whole.getValue() != split.getValue()) throw new AssertionError("Split CRC mismatch");
        System.out.printf("%08x%n", whole.getValue());
    }
}
