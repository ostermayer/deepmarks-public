package org.deepmarks.app;

import java.lang.reflect.Method;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class NostrNip04 {
    private NostrNip04() {}

    static String encrypt(String nsecHex, String peerPubkeyHex, String plaintext) throws Exception {
        byte[] key = NostrCrypto.sharedSecretX(nsecHex, peerPubkeyHex);
        byte[] iv = NostrCrypto.randomBytes(16);
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
        return base64Encode(cipher.doFinal(plaintext.getBytes("UTF-8"))) + "?iv=" + base64Encode(iv);
    }

    static String decrypt(String nsecHex, String peerPubkeyHex, String payload) throws Exception {
        int marker = payload.indexOf("?iv=");
        if (marker < 1) throw new IllegalArgumentException("invalid nip04 payload");
        byte[] ciphertext = base64Decode(payload.substring(0, marker));
        byte[] iv = base64Decode(payload.substring(marker + 4));
        if (iv.length != 16) throw new IllegalArgumentException("invalid nip04 iv");
        byte[] key = NostrCrypto.sharedSecretX(nsecHex, peerPubkeyHex);
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
        return new String(cipher.doFinal(ciphertext), "UTF-8");
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
}
