package org.deepmarks.app;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

final class NostrNip44 {
    private static final int VERSION = 2;
    private static final int MIN_PLAINTEXT_SIZE = 1;
    private static final int MAX_PLAINTEXT_SIZE = 65_535;
    private static final byte[] V2_SALT = "nip44-v2".getBytes(StandardCharsets.UTF_8);

    private NostrNip44() {}

    static byte[] conversationKey(String nsecHex, String peerPubkeyHex) throws Exception {
        byte[] sharedX = NostrCrypto.sharedSecretX(nsecHex, peerPubkeyHex);
        return NostrCrypto.hkdfExtract(V2_SALT, sharedX);
    }

    static String encrypt(String plaintext, byte[] conversationKey) throws Exception {
        return encrypt(plaintext, conversationKey, NostrCrypto.randomBytes(32));
    }

    static String encrypt(String plaintext, byte[] conversationKey, byte[] nonce) throws Exception {
        MessageKeys keys = messageKeys(conversationKey, nonce);
        byte[] padded = pad(plaintext);
        byte[] ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, padded);
        byte[] mac = hmacAad(keys.hmacKey, ciphertext, nonce);
        return base64Encode(NostrCrypto.concat(new byte[] { VERSION }, nonce, ciphertext, mac));
    }

    static String decrypt(String payload, byte[] conversationKey) throws Exception {
        Payload decoded = decodePayload(payload);
        MessageKeys keys = messageKeys(conversationKey, decoded.nonce);
        byte[] calculatedMac = hmacAad(keys.hmacKey, decoded.ciphertext, decoded.nonce);
        if (!NostrCrypto.constantTimeEquals(calculatedMac, decoded.mac)) {
            throw new IllegalArgumentException("invalid MAC");
        }
        return unpad(chacha20(keys.chachaKey, keys.chachaNonce, decoded.ciphertext));
    }

    static int calcPaddedLen(int len) {
        if (len < MIN_PLAINTEXT_SIZE) throw new IllegalArgumentException("expected positive integer");
        if (len <= 32) return 32;
        int nextPower = Integer.highestOneBit(len - 1) << 1;
        int chunk = nextPower <= 256 ? 32 : nextPower / 8;
        return chunk * (((len - 1) / chunk) + 1);
    }

    private static MessageKeys messageKeys(byte[] conversationKey, byte[] nonce) throws Exception {
        if (conversationKey.length != 32) throw new IllegalArgumentException("conversation key must be 32 bytes");
        if (nonce.length != 32) throw new IllegalArgumentException("nonce must be 32 bytes");
        byte[] keys = NostrCrypto.hkdfExpand(conversationKey, nonce, 76);
        return new MessageKeys(
            Arrays.copyOfRange(keys, 0, 32),
            Arrays.copyOfRange(keys, 32, 44),
            Arrays.copyOfRange(keys, 44, 76)
        );
    }

    private static byte[] pad(String plaintext) {
        byte[] unpadded = plaintext.getBytes(StandardCharsets.UTF_8);
        int len = unpadded.length;
        if (len < MIN_PLAINTEXT_SIZE || len > MAX_PLAINTEXT_SIZE) {
            throw new IllegalArgumentException("invalid plaintext size: must be between 1 and 65535 bytes");
        }
        byte[] padded = new byte[2 + calcPaddedLen(len)];
        padded[0] = (byte) ((len >>> 8) & 0xff);
        padded[1] = (byte) (len & 0xff);
        System.arraycopy(unpadded, 0, padded, 2, len);
        return padded;
    }

    private static String unpad(byte[] padded) {
        if (padded.length < 2) throw new IllegalArgumentException("invalid padding");
        int len = ((padded[0] & 0xff) << 8) | (padded[1] & 0xff);
        if (
            len < MIN_PLAINTEXT_SIZE ||
            len > MAX_PLAINTEXT_SIZE ||
            padded.length != 2 + calcPaddedLen(len) ||
            2 + len > padded.length
        ) {
            throw new IllegalArgumentException("invalid padding");
        }
        return new String(padded, 2, len, StandardCharsets.UTF_8);
    }

    private static byte[] hmacAad(byte[] key, byte[] message, byte[] aad) throws Exception {
        if (aad.length != 32) throw new IllegalArgumentException("AAD associated data must be 32 bytes");
        return NostrCrypto.hmacSha256(key, NostrCrypto.concat(aad, message));
    }

    private static Payload decodePayload(String payload) {
        if (payload == null) throw new IllegalArgumentException("payload must be a valid string");
        int plen = payload.length();
        if (plen < 132 || plen > 87_472) throw new IllegalArgumentException("invalid payload length: " + plen);
        if (payload.charAt(0) == '#') throw new IllegalArgumentException("unknown encryption version");
        byte[] data;
        try {
            data = base64Decode(payload);
        } catch (Exception e) {
            throw new IllegalArgumentException("invalid base64: " + e.getMessage(), e);
        }
        int dlen = data.length;
        if (dlen < 99 || dlen > 65_603) throw new IllegalArgumentException("invalid data length: " + dlen);
        int version = data[0] & 0xff;
        if (version != VERSION) throw new IllegalArgumentException("unknown encryption version " + version);
        return new Payload(
            Arrays.copyOfRange(data, 1, 33),
            Arrays.copyOfRange(data, 33, data.length - 32),
            Arrays.copyOfRange(data, data.length - 32, data.length)
        );
    }

    private static byte[] chacha20(byte[] key, byte[] nonce, byte[] input) {
        if (key.length != 32) throw new IllegalArgumentException("chacha key must be 32 bytes");
        if (nonce.length != 12) throw new IllegalArgumentException("chacha nonce must be 12 bytes");
        byte[] output = new byte[input.length];
        int counter = 0;
        byte[] block = new byte[64];
        int[] state = new int[16];
        int[] working = new int[16];
        for (int pos = 0; pos < input.length; pos += 64) {
            chachaBlock(key, nonce, counter, block, state, working);
            int take = Math.min(64, input.length - pos);
            for (int i = 0; i < take; i++) output[pos + i] = (byte) (input[pos + i] ^ block[i]);
            counter += 1;
            if (counter == 0) throw new IllegalStateException("chacha counter overflow");
        }
        return output;
    }

    private static void chachaBlock(byte[] key, byte[] nonce, int counter, byte[] out, int[] state, int[] x) {
        state[0] = 0x61707865;
        state[1] = 0x3320646e;
        state[2] = 0x79622d32;
        state[3] = 0x6b206574;
        for (int i = 0; i < 8; i++) state[4 + i] = littleEndianToInt(key, i * 4);
        state[12] = counter;
        state[13] = littleEndianToInt(nonce, 0);
        state[14] = littleEndianToInt(nonce, 4);
        state[15] = littleEndianToInt(nonce, 8);
        System.arraycopy(state, 0, x, 0, 16);
        for (int i = 0; i < 10; i++) {
            quarterRound(x, 0, 4, 8, 12);
            quarterRound(x, 1, 5, 9, 13);
            quarterRound(x, 2, 6, 10, 14);
            quarterRound(x, 3, 7, 11, 15);
            quarterRound(x, 0, 5, 10, 15);
            quarterRound(x, 1, 6, 11, 12);
            quarterRound(x, 2, 7, 8, 13);
            quarterRound(x, 3, 4, 9, 14);
        }
        for (int i = 0; i < 16; i++) intToLittleEndian(x[i] + state[i], out, i * 4);
    }

    private static void quarterRound(int[] x, int a, int b, int c, int d) {
        x[a] += x[b]; x[d] = Integer.rotateLeft(x[d] ^ x[a], 16);
        x[c] += x[d]; x[b] = Integer.rotateLeft(x[b] ^ x[c], 12);
        x[a] += x[b]; x[d] = Integer.rotateLeft(x[d] ^ x[a], 8);
        x[c] += x[d]; x[b] = Integer.rotateLeft(x[b] ^ x[c], 7);
    }

    private static int littleEndianToInt(byte[] in, int offset) {
        return (in[offset] & 0xff) |
            ((in[offset + 1] & 0xff) << 8) |
            ((in[offset + 2] & 0xff) << 16) |
            ((in[offset + 3] & 0xff) << 24);
    }

    private static void intToLittleEndian(int value, byte[] out, int offset) {
        out[offset] = (byte) value;
        out[offset + 1] = (byte) (value >>> 8);
        out[offset + 2] = (byte) (value >>> 16);
        out[offset + 3] = (byte) (value >>> 24);
    }

    private static String base64Encode(byte[] bytes) throws Exception {
        try {
            Class<?> base64 = Class.forName("java.util.Base64");
            Object encoder = base64.getMethod("getEncoder").invoke(null);
            Method method = encoder.getClass().getMethod("encodeToString", byte[].class);
            return (String) method.invoke(encoder, bytes);
        } catch (ClassNotFoundException | NoClassDefFoundError ignored) {
            return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
        }
    }

    private static byte[] base64Decode(String payload) throws Exception {
        try {
            Class<?> base64 = Class.forName("java.util.Base64");
            Object decoder = base64.getMethod("getDecoder").invoke(null);
            Method method = decoder.getClass().getMethod("decode", String.class);
            return (byte[]) method.invoke(decoder, payload);
        } catch (ClassNotFoundException | NoClassDefFoundError ignored) {
            return android.util.Base64.decode(payload, android.util.Base64.DEFAULT);
        }
    }

    private static final class MessageKeys {
        final byte[] chachaKey;
        final byte[] chachaNonce;
        final byte[] hmacKey;

        MessageKeys(byte[] chachaKey, byte[] chachaNonce, byte[] hmacKey) {
            this.chachaKey = chachaKey;
            this.chachaNonce = chachaNonce;
            this.hmacKey = hmacKey;
        }
    }

    private static final class Payload {
        final byte[] nonce;
        final byte[] ciphertext;
        final byte[] mac;

        Payload(byte[] nonce, byte[] ciphertext, byte[] mac) {
            this.nonce = nonce;
            this.ciphertext = ciphertext;
            this.mac = mac;
        }
    }
}
