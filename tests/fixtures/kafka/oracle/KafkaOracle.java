/* Test-only independent Kafka Java-client oracle. Project-owned harness; not production. */
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.internals.RecordHeader;
import org.apache.kafka.common.serialization.ByteArrayDeserializer;
import org.apache.kafka.common.serialization.ByteArraySerializer;

/** Binary manifests preserve nullable bytes and duplicate headers without a JSON library. */
public final class KafkaOracle {
    static final int INPUT_MAGIC = 0x4b4f5031, OUTPUT_MAGIC = 0x4b4f5231;
    static final int MAX_INPUT = 2 * 1024 * 1024, MAX_OUTPUT = 4 * 1024 * 1024;
    static final int MAX_BYTES = 1024 * 1024, MAX_RECORDS = 1024, MAX_HEADERS = 32;
    static final long CLEANUP_MS = 5000;
    record Item(long timestamp, byte[] key, byte[] value, List<Header> headers) {}
    record Input(int operation, String bootstrap, String topic, int partition,
                 List<Item> items, long offset, int count, int waitMs) {}
    record Ack(int partition, long offset, long timestamp) {}
    record Seen(long offset, long timestamp, String timestampType,
                byte[] key, byte[] value, List<Header> headers) {}
    record Fault(String phase, Throwable error) {}
    static final class Result {
        int operation, partition = -1, attempted = -1;
        String topic = "";
        boolean unknown;
        final List<Ack> acks = new ArrayList<>();
        final List<Seen> records = new ArrayList<>();
        final List<Fault> faults = new ArrayList<>();
    }
    static final class Budget {
        int bytes;
        void add(int n) throws IOException {
            if (n < 0 || n > MAX_BYTES - bytes) throw new IOException("Aggregate record bytes exceed policy");
            bytes += n;
        }
    }
    static int count(DataInputStream in, int maximum) throws IOException {
        int n = in.readInt();
        if (n < 0 || n > maximum) throw new IOException("Count exceeds policy");
        return n;
    }
    static byte[] bytes(DataInputStream in, int max, boolean nullable, Budget budget) throws IOException {
        int n = in.readInt();
        if (n == -1 && nullable) return null;
        if (n < 0 || n > max) throw new IOException("Byte length exceeds policy");
        if (budget != null) budget.add(n);
        byte[] b = in.readNBytes(n);
        if (b.length != n) throw new EOFException("Truncated byte field");
        return b;
    }
    static String text(DataInputStream in, int max, Budget budget) throws IOException {
        byte[] b = bytes(in, max, false, budget);
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString();
    }
    static List<Header> headers(DataInputStream in, Budget budget) throws IOException {
        int n = count(in, MAX_HEADERS);
        List<Header> h = new ArrayList<>(n);
        for (int i = 0; i < n; i++) h.add(new RecordHeader(text(in, 256, budget), bytes(in, MAX_BYTES, true, budget)));
        return h;
    }
    /** Admit the entire immutable input before constructing a client or resolving metadata. */
    static Input input() throws IOException {
        byte[] all = System.in.readNBytes(MAX_INPUT + 1);
        if (all.length > MAX_INPUT) throw new IOException("Input exceeds policy");
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(all));
        if (in.readInt() != INPUT_MAGIC) throw new IOException("Unexpected input magic/version");
        int operation = in.readUnsignedByte();
        if (operation != 1 && operation != 2) throw new IOException("Unknown operation");
        String bootstrap = text(in, 64, null);
        if (!bootstrap.matches("127\\.0\\.0\\.1:[0-9]{1,5}")) throw new IOException("Only fixture loopback is admitted");
        int port = Integer.parseInt(bootstrap.substring(10));
        if (port < 1 || port > 65535) throw new IOException("Invalid loopback port");
        String topic = text(in, 249, null);
        if (!topic.matches("[A-Za-z0-9._-]{1,249}") || topic.equals(".") || topic.equals(".."))
            throw new IOException("Invalid explicit topic");
        int partition = in.readInt();
        if (partition < 0) throw new IOException("Invalid partition");
        List<Item> items = new ArrayList<>();
        long offset = 0;
        int amount = 0, waitMs = 0;
        if (operation == 1) {
            int n = count(in, MAX_RECORDS);
            if (n == 0) throw new IOException("Append needs a record");
            Budget budget = new Budget();
            for (int i = 0; i < n; i++) {
                long timestamp = in.readLong();
                if (timestamp < 0) throw new IOException("Timestamp must be explicit and nonnegative");
                items.add(new Item(timestamp, bytes(in, MAX_BYTES, true, budget),
                        bytes(in, MAX_BYTES, true, budget), headers(in, budget)));
            }
        } else {
            offset = in.readLong();
            amount = count(in, MAX_RECORDS);
            waitMs = count(in, 10000);
            if (offset < 0 || amount == 0 || waitMs == 0) throw new IOException("Invalid fetch policy");
        }
        if (in.read() != -1) throw new IOException("Trailing input bytes");
        return new Input(operation, bootstrap, topic, partition, items, offset, amount, waitMs);
    }
    static Properties properties(Input in) {
        Properties p = new Properties();
        p.setProperty("bootstrap.servers", in.bootstrap());
        p.setProperty("client.id", "opfs-independent-oracle");
        p.setProperty("security.protocol", "PLAINTEXT");
        p.setProperty("request.timeout.ms", "5000");
        p.setProperty("socket.connection.setup.timeout.ms", "3000");
        p.setProperty("socket.connection.setup.timeout.max.ms", "3000");
        p.setProperty("allow.auto.create.topics", "false");
        return p;
    }
    static long remaining(long deadline) throws TimeoutException {
        long n = deadline - System.nanoTime();
        if (n <= 0) throw new TimeoutException("Oracle operation deadline exceeded");
        return n;
    }
    /** Acknowledgments survive later failures; a submitted record without one stays unknown. */
    static void append(Input in, Result result) {
        KafkaProducer<byte[], byte[]> producer = null;
        try {
            Properties p = properties(in);
            p.remove("allow.auto.create.topics"); // Consumer-only; topic setup is external.
            p.setProperty("acks", "all");
            p.setProperty("enable.idempotence", "false");
            p.setProperty("retries", "0");
            p.setProperty("max.in.flight.requests.per.connection", "1");
            p.setProperty("delivery.timeout.ms", "10000");
            p.setProperty("max.block.ms", "5000");
            p.setProperty("linger.ms", "0");
            p.setProperty("compression.type", "none");
            p.setProperty("max.request.size", "2097152");
            p.setProperty("buffer.memory", "4194304");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            producer = new KafkaProducer<>(p, new ByteArraySerializer(), new ByteArraySerializer());
            for (int i = 0; i < in.items().size(); i++) {
                remaining(deadline);
                Item item = in.items().get(i);
                ProducerRecord<byte[], byte[]> record = new ProducerRecord<>(in.topic(), in.partition(),
                        item.timestamp(), item.key(), item.value(), item.headers());
                result.attempted = i;
                result.unknown = true; // Conservative even when send() itself throws.
                RecordMetadata ack = producer.send(record).get(remaining(deadline), TimeUnit.NANOSECONDS);
                if (!ack.topic().equals(in.topic()) || ack.partition() != in.partition() || !ack.hasOffset())
                    throw new IOException("Acknowledgment identity/offset mismatch");
                result.acks.add(new Ack(ack.partition(), ack.offset(), ack.timestamp()));
                result.unknown = false;
            }
        } catch (Throwable fault) {
            result.faults.add(new Fault("operation", fault));
        } finally {
            if (producer != null) {
                try { producer.close(Duration.ofMillis(CLEANUP_MS)); }
                catch (Throwable fault) { result.faults.add(new Fault("cleanup", fault)); }
            }
        }
    }
    /** One nonempty SDK poll page or deadline; assignment/seek never joins a consumer group. */
    static void fetch(Input in, Result result) {
        KafkaConsumer<byte[], byte[]> consumer = null;
        try {
            Properties p = properties(in);
            p.setProperty("enable.auto.commit", "false");
            p.setProperty("auto.offset.reset", "none");
            p.setProperty("isolation.level", "read_uncommitted");
            p.setProperty("max.poll.records", Integer.toString(in.count()));
            p.setProperty("fetch.max.bytes", "1048576");
            p.setProperty("max.partition.fetch.bytes", "1048576");
            p.setProperty("fetch.max.wait.ms", "250");
            p.setProperty("default.api.timeout.ms", "5000");
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(in.waitMs());
            consumer = new KafkaConsumer<>(p, new ByteArrayDeserializer(), new ByteArrayDeserializer());
            TopicPartition partition = new TopicPartition(in.topic(), in.partition());
            consumer.assign(List.of(partition));
            consumer.seek(partition, in.offset());
            Budget budget = new Budget();
            List<Seen> page = new ArrayList<>();
            while (page.isEmpty() && System.nanoTime() < deadline) {
                ConsumerRecords<byte[], byte[]> records = consumer.poll(Duration.ofNanos(
                        Math.max(1, Math.min(deadline - System.nanoTime(), TimeUnit.SECONDS.toNanos(1)))));
                for (ConsumerRecord<byte[], byte[]> record : records) {
                    if (!record.topic().equals(in.topic()) || record.partition() != in.partition()
                            || record.offset() < in.offset() || page.size() >= in.count())
                        throw new IOException("Fetch identity/offset/count mismatch");
                    if (!page.isEmpty() && record.offset() <= page.get(page.size() - 1).offset())
                        throw new IOException("Non-increasing record offsets");
                    byte[] key = record.key(), value = record.value();
                    if (key != null) budget.add(key.length);
                    if (value != null) budget.add(value.length);
                    List<Header> headers = new ArrayList<>();
                    for (Header header : record.headers()) {
                        byte[] name = header.key().getBytes(StandardCharsets.UTF_8);
                        if (headers.size() >= MAX_HEADERS || name.length > 256)
                            throw new IOException("Header policy exceeded");
                        budget.add(name.length);
                        if (header.value() != null) budget.add(header.value().length);
                        headers.add(new RecordHeader(header.key(), header.value()));
                    }
                    page.add(new Seen(record.offset(), record.timestamp(), record.timestampType().name(), key, value, headers));
                }
            }
            // Publish only the fully admitted SDK page. Empty is a bounded observation, not EOF.
            result.records.addAll(page);
        } catch (Throwable fault) {
            result.faults.add(new Fault("operation", fault));
        } finally {
            if (consumer != null) {
                try { consumer.close(Duration.ofMillis(CLEANUP_MS)); }
                catch (Throwable fault) { result.faults.add(new Fault("cleanup", fault)); }
            }
        }
    }
    static void bytes(DataOutputStream out, byte[] value) throws IOException {
        out.writeInt(value == null ? -1 : value.length);
        if (value != null) out.write(value);
    }
    static void text(DataOutputStream out, String value) throws IOException {
        bytes(out, value.getBytes(StandardCharsets.UTF_8));
    }
    /** Retain cause/suppressed identity under explicit diagnostic depth/count/message caps. */
    static void faults(DataOutputStream out, List<Fault> faults) throws IOException {
        record Node(String path, Throwable error, int depth) {}
        List<Node> nodes = new ArrayList<>();
        Map<String, Set<Throwable>> visited = new HashMap<>();
        ArrayDeque<Node> queue = new ArrayDeque<>();
        for (Fault f : faults) queue.add(new Node(f.phase(), f.error(), 0));
        boolean truncated = false;
        while (!queue.isEmpty() && nodes.size() < 16) {
            Node n = queue.removeFirst();
            String root = n.path().split("/", 2)[0];
            Set<Throwable> seen = visited.computeIfAbsent(root, ignored -> Collections.newSetFromMap(new IdentityHashMap<>()));
            if (!seen.add(n.error())) continue;
            nodes.add(n);
            if (n.depth() >= 4) { truncated = true; continue; }
            if (n.error().getCause() != null) queue.addLast(new Node(n.path() + "/cause", n.error().getCause(), n.depth() + 1));
            Throwable[] suppressed = n.error().getSuppressed();
            for (int i = 0; i < Math.min(4, suppressed.length); i++)
                queue.addLast(new Node(n.path() + "/suppressed" + i, suppressed[i], n.depth() + 1));
            truncated |= suppressed.length > 4;
        }
        truncated |= !queue.isEmpty();
        out.writeBoolean(truncated);
        out.writeInt(nodes.size());
        for (Node n : nodes) {
            text(out, n.path());
            text(out, n.error().getClass().getName());
            String message = n.error().getMessage();
            if (message != null && message.length() > 1024) message = message.substring(0, 1024);
            bytes(out, message == null ? null : message.getBytes(StandardCharsets.UTF_8));
        }
    }
    static byte[] output(Result result) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        OutputStream bounded = new OutputStream() {
            int count;
            @Override public void write(int value) throws IOException {
                if (count >= MAX_OUTPUT) throw new IOException("Output policy exceeded");
                buffer.write(value); count++;
            }
            @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                if (length > MAX_OUTPUT - count) throw new IOException("Output policy exceeded");
                buffer.write(bytes, offset, length); count += length;
            }
        };
        DataOutputStream out = new DataOutputStream(bounded);
        out.writeInt(OUTPUT_MAGIC);
        out.writeByte(result.operation);
        out.writeByte(result.faults.isEmpty() ? 0 : 1);
        text(out, result.topic);
        out.writeInt(result.partition);
        out.writeInt(result.attempted);
        out.writeBoolean(result.unknown);
        out.writeInt(result.acks.size());
        for (Ack ack : result.acks) {
            out.writeInt(ack.partition()); out.writeLong(ack.offset()); out.writeLong(ack.timestamp());
        }
        out.writeInt(result.records.size());
        for (Seen record : result.records) {
            out.writeLong(record.offset()); out.writeLong(record.timestamp()); text(out, record.timestampType());
            bytes(out, record.key()); bytes(out, record.value()); out.writeInt(record.headers().size());
            for (Header h : record.headers()) { text(out, h.key()); bytes(out, h.value()); }
        }
        faults(out, result.faults);
        out.flush();
        return buffer.toByteArray();
    }
    public static void main(String[] args) throws IOException {
        Result result = new Result();
        try {
            if (args.length != 0) throw new IOException("No command-line arguments are accepted");
            Input in = input();
            result.operation = in.operation(); result.topic = in.topic(); result.partition = in.partition();
            if (in.operation() == 1) append(in, result); else fetch(in, result);
        } catch (Throwable fault) { result.faults.add(new Fault("admission", fault)); }
        // No output prefix is emitted before all observations and cleanup are encoded.
        byte[] encoded = output(result);
        System.out.write(encoded); System.out.flush();
        if (!result.faults.isEmpty()) System.exit(1);
    }
}
