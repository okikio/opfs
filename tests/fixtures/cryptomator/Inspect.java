/* Authored JDK-only JAR inspection. No downloaded classes or setup scripts load. */
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

public class Inspect {
  private static final int MIB = 1024 * 1024;

  /* JSON quoting is separate from JAR interpretation and never executes text. */
  private static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (int index = 0; index < text.length(); index++) {
      char value = text.charAt(index);
      if (value == '"' || value == '\\') out.append('\\').append(value);
      else if (value < 32) out.append(String.format("\\u%04x", (int)value));
      else out.append(value);
    }
    return out.append('"').toString();
  }

  private static byte[] bounded(JarFile jar, JarEntry entry, int limit) throws Exception {
    if (entry.getSize() < 0 || entry.getSize() > limit) throw new IllegalArgumentException("Entry exceeds declared byte budget");
    try (InputStream stream = jar.getInputStream(entry)) {
      byte[] bytes = stream.readNBytes(limit + 1);
      if (bytes.length > limit || bytes.length != entry.getSize()) throw new IllegalArgumentException("Entry exceeds actual byte budget");
      return bytes;
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 1) throw new IllegalArgumentException("Expected one admitted JAR path");
    List<String> licenses = new ArrayList<>();
    Map<String, Map<Integer, Integer>> classes = new TreeMap<>();
    String manifest = "null";
    int count = 0, licenseBytes = 0;
    // SHA-256 admission belongs to acquire.ts. No signing-key trust is inferred
    // from the JAR itself, and no Java class is initialized during this read.
    try (JarFile jar = new JarFile(Path.of(args[0]).toFile(), false)) {
      Enumeration<JarEntry> entries = jar.entries();
      while (entries.hasMoreElements()) {
        JarEntry entry = entries.nextElement();
        if (++count > 20000) throw new IllegalArgumentException("Too many JAR entries");
        String name = entry.getName(), upper = name.toUpperCase(java.util.Locale.ROOT);
        if (upper.startsWith("META-INF/") && (upper.contains("LICENSE") || upper.contains("NOTICE"))) {
          if (licenses.size() >= 64) throw new IllegalArgumentException("Too many embedded licenses");
          byte[] text = bounded(jar, entry, MIB);
          licenseBytes += text.length;
          if (licenseBytes > 2 * MIB) throw new IllegalArgumentException("Embedded licenses exceed aggregate budget");
          String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text));
          licenses.add("{\"path\":" + quote(name) + ",\"bytes\":" + text.length + ",\"sha256\":" + quote(digest) + ",\"text\":" + quote(new String(text, StandardCharsets.UTF_8)) + "}");
        }
        if (name.endsWith(".class")) {
          try (InputStream stream = jar.getInputStream(entry)) {
            byte[] prefix = stream.readNBytes(8);
            if (prefix.length != 8 || (prefix[0] & 255) != 202 || (prefix[1] & 255) != 254 || (prefix[2] & 255) != 186 || (prefix[3] & 255) != 190) throw new IllegalArgumentException("Malformed Java class prefix");
            int major = ((prefix[6] & 255) << 8) | (prefix[7] & 255);
            String section = "base";
            if (name.startsWith("META-INF/versions/")) {
              String[] parts = name.split("/");
              if (parts.length < 4 || !parts[2].matches("[0-9]+")) throw new IllegalArgumentException("Malformed multi-release class path");
              section = "release-" + parts[2];
            }
            if (section.equals("base") && major > 61) throw new IllegalArgumentException("Base class requires a JVM newer than Java17");
            classes.computeIfAbsent(section, ignored -> new TreeMap<>()).merge(major, 1, Integer::sum);
          }
        }
        if (name.equals("META-INF/MANIFEST.MF")) manifest = quote(new String(bounded(jar, entry, MIB), StandardCharsets.UTF_8));
      }
    }
    List<String> sections = new ArrayList<>();
    for (var section : classes.entrySet()) {
      List<String> versions = new ArrayList<>();
      for (var version : section.getValue().entrySet()) versions.add(quote(version.getKey().toString()) + ":" + version.getValue());
      sections.add(quote(section.getKey()) + ":{" + String.join(",", versions) + "}");
    }
    System.out.println("{\"embeddedLicenses\":[" + String.join(",", licenses) + "],\"classMajorCounts\":{" + String.join(",", sections) + "},\"multiReleaseManifest\":" + manifest + ",\"licenseBytes\":" + licenseBytes + "}");
  }
}
