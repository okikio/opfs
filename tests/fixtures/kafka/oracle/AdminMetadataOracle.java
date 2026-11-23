/* Project-owned test-only harness of the admitted Apache Kafka public Admin API; no candidate imports. */
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.DescribeClusterResult;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.common.KafkaFuture;
import org.apache.kafka.common.Node;
import org.apache.kafka.common.TopicPartitionInfo;

/**
 * Emit AMO1 binary observation, not Metadata wire errors. No JSON library or production dependency.
 * Admin futures may use newer protocols and observe different instants; compare only in a stable owned fixture.
 */
public final class AdminMetadataOracle {
    static final int MAX_OUTPUT = 1048576, MAX_NODES = 128, MAX_PARTITIONS = 1024;
    static final long WAIT_NANOS = TimeUnit.SECONDS.toNanos(20);
    record Observation(String cluster, int controller, List<Node> nodes, TopicDescription topic) {}
    record Fault(String phase, String type) {}

    /** Bound every serialized byte, including fault output; no partially serialized envelope reaches stdout. */
    static final class Bounded extends OutputStream {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        @Override public void write(int value) throws IOException {
            if (bytes.size() >= MAX_OUTPUT) throw new IOException("Admin output ceiling");
            bytes.write(value);
        }
        @Override public void write(byte[] value, int at, int count) throws IOException {
            if (count < 0 || count > MAX_OUTPUT - bytes.size()) throw new IOException("Admin output ceiling");
            bytes.write(value, at, count);
        }
    }
    static void require(boolean value) throws IOException {
        if (!value) throw new IOException("Admin fixture contract");
    }
    /** UTF-8 length counts bytes, -1 means null; this harness format deliberately uses int32 strings. */
    static void text(DataOutputStream out, String value, int maximum, boolean nullable) throws IOException {
        if (value == null) {
            require(nullable);
            out.writeInt(-1);
            return;
        }
        require(value.length() <= maximum);
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        require(bytes.length <= maximum);
        out.writeInt(bytes.length);
        out.write(bytes);
    }
    static int nodeId(Node node) throws IOException {
        if (node == null || node.id() == -1) return -1;
        require(node.id() >= 0);
        return node.id();
    }
    static void nodes(DataOutputStream out, Collection<Node> nodes) throws IOException {
        require(nodes.size() <= MAX_NODES);
        out.writeInt(nodes.size());
        Set<Integer> ids = new HashSet<>();
        for (Node node : nodes) {
            require(node != null && node.id() >= 0 && ids.add(node.id()));
            require(node.port() >= 1 && node.port() <= 65535);
            out.writeInt(node.id());
            text(out, node.host(), 1024, false);
            out.writeInt(node.port());
            text(out, node.rack(), 1024, true);
        }
    }
    /** Replica assignment order is significant; ISR order is not guaranteed by the SDK. */
    static void ids(DataOutputStream out, List<Node> nodes) throws IOException {
        require(nodes.size() <= MAX_NODES);
        out.writeInt(nodes.size());
        Set<Integer> ids = new HashSet<>();
        for (Node node : nodes) {
            require(node != null && node.id() >= 0 && ids.add(node.id()));
            out.writeInt(node.id());
        }
    }
    static <T> T await(KafkaFuture<T> future, long deadline) throws Exception {
        long left = deadline - System.nanoTime();
        if (left <= 0) throw new java.util.concurrent.TimeoutException("Admin observation deadline");
        return future.get(left, TimeUnit.NANOSECONDS);
    }
    /** Admit CLI input before constructing a native client. Only the owned dynamic loopback fixture is accepted. */
    public static void main(String[] args) throws Exception {
        require(args.length == 3 && args[0].matches("127\\.0\\.0\\.1:[0-9]{1,5}") &&
                args[1].matches("opfs-[A-Za-z0-9._-]{1,200}") && args[2].matches("[0-9]{1,10}"));
        int port = Integer.parseInt(args[0].substring(10)), wanted = Integer.parseInt(args[2]);
        require(port >= 1 && port <= 65535 && wanted >= 0);
        Properties config = new Properties();
        config.setProperty("bootstrap.servers", args[0]);
        config.setProperty("client.id", "opfs-admin-metadata-oracle");
        config.setProperty("security.protocol", "PLAINTEXT");
        config.setProperty("request.timeout.ms", "5000");
        config.setProperty("default.api.timeout.ms", "15000");
        config.setProperty("retries", "0");
        config.setProperty("receive.buffer.bytes", "65536");
        AdminClient client = null;
        Observation observation = null;
        List<Fault> faults = new ArrayList<>();
        try {
            long deadline = System.nanoTime() + WAIT_NANOS;
            client = AdminClient.create(config);
            DescribeClusterResult cluster = client.describeCluster();
            Collection<Node> clusterNodes = await(cluster.nodes(), deadline);
            require(clusterNodes.size() <= MAX_NODES);
            List<Node> copiedNodes = List.copyOf(clusterNodes);
            String clusterId = await(cluster.clusterId(), deadline);
            int controller = nodeId(await(cluster.controller(), deadline));
            TopicDescription topic = await(client.describeTopics(List.of(args[1])).allTopicNames(), deadline).get(args[1]);
            require(topic != null && topic.name().equals(args[1]) && topic.partitions().size() <= MAX_PARTITIONS);
            require(topic.partitions().stream().anyMatch(partition -> partition.partition() == wanted));
            observation = new Observation(clusterId, controller, copiedNodes, topic);
        } catch (Exception error) {
            faults.add(new Fault("observation", error.getClass().getName()));
        }
        if (client != null) {
            try { client.close(Duration.ofSeconds(5)); }
            catch (Exception error) { faults.add(new Fault("cleanup", error.getClass().getName())); }
        }
        Bounded bounded = new Bounded();
        DataOutputStream out = new DataOutputStream(bounded);
        out.writeInt(0x414d4f31); // AMO1
        out.writeBoolean(observation != null);
        if (observation != null) {
            text(out, observation.cluster(), 1024, true);
            out.writeInt(observation.controller());
            nodes(out, observation.nodes());
            text(out, observation.topic().name(), 249, false);
            out.writeBoolean(observation.topic().isInternal());
            out.writeInt(wanted);
            out.writeInt(observation.topic().partitions().size());
            Set<Integer> seen = new HashSet<>();
            for (TopicPartitionInfo partition : observation.topic().partitions()) {
                require(partition.partition() >= 0 && seen.add(partition.partition()));
                out.writeInt(partition.partition());
                out.writeInt(nodeId(partition.leader()));
                ids(out, partition.replicas());
                ids(out, partition.isr());
            }
        }
        out.writeInt(faults.size());
        for (Fault fault : faults) {
            text(out, fault.phase(), 32, false);
            text(out, fault.type(), 512, false);
        }
        out.flush();
        System.out.write(bounded.bytes.toByteArray());
        System.out.flush();
        if (!faults.isEmpty()) System.exit(1);
    }
}
