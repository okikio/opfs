/* Authored interoperability harness. Uses released public APIs; no copied cryptolib implementation. */
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Arrays;
import com.google.common.io.BaseEncoding;
import org.cryptomator.cryptolib.api.*;

public class Native {
  private static byte[] bytes(ByteBuffer buffer) {
    byte[] result = new byte[buffer.remaining()];
    buffer.get(result);
    return result;
  }
  public static void main(String[] args) throws Exception {
    // All paths are fixed, authored producer paths under its private temporary directory.
    Path dir = Path.of(args[1]);
    byte[] key = Files.readAllBytes(dir.resolve("key.bin"));
    try (Cryptor cryptor = CryptorProvider.forScheme(CryptorProvider.Scheme.SIV_GCM).provide(new Masterkey(key), new SecureRandom())) {
      if (args[0].equals("encrypt")) {
        byte[] plain = Files.readAllBytes(dir.resolve("original.bin"));
        FileHeader header = cryptor.fileHeaderCryptor().create();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        out.write(bytes(cryptor.fileHeaderCryptor().encryptHeader(header)));
        for (int at = 0, index = 0; at < plain.length; at += 32768, index++) {
          out.write(bytes(cryptor.fileContentCryptor().encryptChunk(ByteBuffer.wrap(Arrays.copyOfRange(plain, at, Math.min(at + 32768, plain.length))), index, header)));
        }
        Files.write(dir.resolve("cipher.bin"), out.toByteArray());
        if (header instanceof javax.security.auth.Destroyable destroyable) destroyable.destroy();
        String name = Files.readString(dir.resolve("name.txt"), StandardCharsets.UTF_8);
        byte[] parent = Files.readAllBytes(dir.resolve("parent.bin"));
        Files.writeString(dir.resolve("name.cipher"), cryptor.fileNameCryptor().encryptFilename(BaseEncoding.base64Url(), name, parent) + ".c9r", StandardCharsets.UTF_8);
      } else if (args[0].equals("decrypt")) {
        byte[] cipher = Files.readAllBytes(dir.resolve("cipher.bin"));
        FileHeader header = cryptor.fileHeaderCryptor().decryptHeader(ByteBuffer.wrap(Arrays.copyOfRange(cipher, 0, 68)));
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (int at = 68, index = 0; at < cipher.length; at += 32796, index++) {
          out.write(bytes(cryptor.fileContentCryptor().decryptChunk(ByteBuffer.wrap(Arrays.copyOfRange(cipher, at, Math.min(at + 32796, cipher.length))), index, header, true)));
        }
        Files.write(dir.resolve("native-decoded.bin"), out.toByteArray());
        if (header instanceof javax.security.auth.Destroyable destroyable) destroyable.destroy();
        String name = Files.readString(dir.resolve("name.cipher"), StandardCharsets.UTF_8);
        byte[] parent = Files.readAllBytes(dir.resolve("parent.bin"));
        Files.writeString(dir.resolve("native-name.txt"), cryptor.fileNameCryptor().decryptFilename(BaseEncoding.base64Url(), name.substring(0, name.length() - 4), parent), StandardCharsets.UTF_8);
      } else {
        throw new IllegalArgumentException("Unknown producer mode");
      }
    } finally {
      Arrays.fill(key, (byte) 0);
    }
  }
}
