package org.deepmarks.app;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class NostrSignerActions {
    private NostrSignerActions() {}

    static NostrEventSigner.SignedEvent signEvent(
        NostrNip46RequestHandler.Account account,
        String raw
    ) throws Exception {
        EventTemplate event = parseEventTemplate(raw);
        if (isUnsignedPrivateZap(event)) {
            return signPrivateZapRequest(account, event);
        }
        return NostrEventSigner.signEvent(
            account.nsecHex,
            event.kind,
            event.createdAt,
            event.tags,
            event.content
        );
    }

    static String nip04Encrypt(
        NostrNip46RequestHandler.Account account,
        String plaintext,
        String peerPubkey
    ) throws Exception {
        return NostrNip04.encrypt(account.nsecHex, peerPubkey, plaintext);
    }

    static String nip04Decrypt(
        NostrNip46RequestHandler.Account account,
        String ciphertext,
        String peerPubkey
    ) throws Exception {
        return NostrNip04.decrypt(account.nsecHex, peerPubkey, ciphertext);
    }

    static String nip44Encrypt(
        NostrNip46RequestHandler.Account account,
        String plaintext,
        String peerPubkey
    ) throws Exception {
        return NostrNip44.encrypt(
            plaintext,
            NostrNip44.conversationKey(account.nsecHex, peerPubkey)
        );
    }

    static String nip44Decrypt(
        NostrNip46RequestHandler.Account account,
        String ciphertext,
        String peerPubkey
    ) throws Exception {
        return NostrNip44.decrypt(
            ciphertext,
            NostrNip44.conversationKey(account.nsecHex, peerPubkey)
        );
    }

    static String decryptZapEvent(
        NostrNip46RequestHandler.Account account,
        String rawEventJson
    ) throws Exception {
        EventTemplate event = parseEventTemplate(rawEventJson);
        if (event.kind != 9734) throw new IllegalArgumentException("event is not a zap request");
        String anon = firstTagValue(event.tags, "anon");
        if (anon == null || anon.isEmpty()) throw new IllegalArgumentException("zap request is not private");
        String recipientPubkey = firstTagValue(event.tags, "p");
        String recipientPost = firstTagValue(event.tags, "e");
        String decryptingPrivkey;
        String decryptingPeer;
        if (account.pubkey.equals(recipientPubkey)) {
            decryptingPrivkey = account.nsecHex;
            decryptingPeer = event.pubkey;
        } else {
            if (recipientPubkey == null || recipientPubkey.isEmpty()) {
                throw new IllegalArgumentException("private zap recipient is missing");
            }
            String idForKey = recipientPost == null || recipientPost.isEmpty() ? recipientPubkey : recipientPost;
            decryptingPrivkey = privateZapDerivedKey(account.nsecHex, idForKey, event.createdAt);
            if (!NostrCrypto.publicKeyHex(decryptingPrivkey).equals(event.pubkey)) {
                throw new IllegalArgumentException("private zap cannot be decrypted by this key");
            }
            decryptingPeer = recipientPubkey;
        }
        String decrypted = decryptPrivateZapMessage(anon, decryptingPrivkey, decryptingPeer);
        EventTemplate privateEvent = parseEventTemplate(decrypted);
        if (privateEvent.kind != 9733) throw new IllegalArgumentException("decrypted event is not a private zap");
        return decrypted;
    }

    static String currentUser(String[] projection) {
        if (projection == null || projection.length < 3) return "";
        return projection[2] == null ? "" : projection[2].trim().toLowerCase(Locale.ROOT);
    }

    static boolean currentUserMatches(
        NostrNip46RequestHandler.Account account,
        String currentUser
    ) {
        return currentUser == null || currentUser.isEmpty() || currentUser.equals(account.pubkey);
    }

    static Integer eventKind(String raw) {
        try {
            return parseEventTemplate(raw).kind;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static NostrEventSigner.SignedEvent signPrivateZapRequest(
        NostrNip46RequestHandler.Account account,
        EventTemplate event
    ) throws Exception {
        String recipientPubkey = firstTagValue(event.tags, "p");
        if (recipientPubkey == null || recipientPubkey.isEmpty()) {
            throw new IllegalArgumentException("private zap recipient is missing");
        }
        String zappedEvent = firstTagValue(event.tags, "e");
        String idForKey = zappedEvent == null || zappedEvent.isEmpty() ? recipientPubkey : zappedEvent;
        String encryptionPrivateKey = privateZapDerivedKey(account.nsecHex, idForKey, event.createdAt);
        List<List<String>> publicTags = withoutTags(event.tags, "anon");
        NostrEventSigner.SignedEvent privateEvent = NostrEventSigner.signEvent(
            account.nsecHex,
            9733,
            System.currentTimeMillis() / 1000L,
            publicTags,
            event.content
        );
        String encrypted = encryptPrivateZapMessage(privateEvent.toJson(), encryptionPrivateKey, recipientPubkey);
        List<List<String>> finalTags = new ArrayList<>(publicTags);
        List<String> anon = new ArrayList<>();
        anon.add("anon");
        anon.add(encrypted);
        finalTags.add(anon);
        return NostrEventSigner.signEvent(
            encryptionPrivateKey,
            event.kind,
            event.createdAt,
            finalTags,
            ""
        );
    }

    private static boolean isUnsignedPrivateZap(EventTemplate event) {
        if (event.kind != 9734) return false;
        for (List<String> tag : event.tags) {
            if (tag.size() > 1 && "anon".equals(tag.get(0)) && tag.get(1).trim().isEmpty()) {
                return true;
            }
        }
        return false;
    }

    private static String privateZapDerivedKey(
        String nsecHex,
        String id,
        long createdAt
    ) throws Exception {
        return NostrCrypto.hex(
            NostrCrypto.sha256((nsecHex + id + createdAt).getBytes(StandardCharsets.UTF_8))
        );
    }

    private static String encryptPrivateZapMessage(
        String plaintext,
        String nsecHex,
        String peerPubkey
    ) throws Exception {
        byte[] shared = NostrCrypto.sharedSecretX(nsecHex, peerPubkey);
        byte[] iv = NostrCrypto.randomBytes(16);
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(shared, "AES"), new IvParameterSpec(iv));
        String encrypted = NostrBech32.encode("pzap", cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8)));
        String encodedIv = NostrBech32.encode("iv", iv);
        return encrypted + "_" + encodedIv;
    }

    private static String decryptPrivateZapMessage(
        String payload,
        String nsecHex,
        String peerPubkey
    ) throws Exception {
        String[] parts = payload.split("_", -1);
        if (parts.length != 2) throw new IllegalArgumentException("invalid private zap payload");
        byte[] ciphertext = NostrBech32.decode(parts[0], "pzap");
        byte[] iv = NostrBech32.decode(parts[1], "iv");
        if (iv.length != 16) throw new IllegalArgumentException("invalid private zap iv");
        byte[] shared = NostrCrypto.sharedSecretX(nsecHex, peerPubkey);
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(shared, "AES"), new IvParameterSpec(iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private static EventTemplate parseEventTemplate(String raw) {
        if (raw == null || raw.isEmpty()) throw new IllegalArgumentException("event template is required");
        Map<String, Object> parsed = NostrJson.parseObject(raw);
        int kind = parseKind(parsed);
        long createdAt = parsed.containsKey("created_at")
            ? parseIntegerLong(parsed, "created_at")
            : System.currentTimeMillis() / 1000L;
        String pubkey = stringValue(parsed.get("pubkey"));
        String content = stringValue(parsed.get("content"));
        return new EventTemplate(
            pubkey == null ? "" : pubkey,
            kind,
            createdAt,
            parseTags(parsed.get("tags")),
            content == null ? "" : content
        );
    }

    private static int parseKind(Map<String, Object> obj) {
        long value = parseIntegerLong(obj, "kind");
        if (value < 0 || value > 65_535) throw new IllegalArgumentException("event.kind must be an integer");
        return (int) value;
    }

    private static long parseIntegerLong(Map<String, Object> obj, String key) {
        Object value = obj.get(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException("event." + key + " must be an integer");
        double asDouble = ((Number) value).doubleValue();
        long asLong = ((Number) value).longValue();
        if (asDouble != asLong) throw new IllegalArgumentException("event." + key + " must be an integer");
        return asLong;
    }

    private static List<List<String>> parseTags(Object rawTags) {
        List<List<String>> tags = new ArrayList<>();
        if (rawTags == null) return tags;
        if (!(rawTags instanceof List)) throw new IllegalArgumentException("event.tags must be an array");
        for (Object rawTag : (List<?>) rawTags) {
            if (!(rawTag instanceof List)) throw new IllegalArgumentException("event.tags entries must be arrays");
            List<String> row = new ArrayList<>();
            for (Object value : (List<?>) rawTag) {
                if (!(value instanceof String)) throw new IllegalArgumentException("event.tags values must be strings");
                row.add((String) value);
            }
            tags.add(row);
        }
        return tags;
    }

    private static String stringValue(Object value) {
        return value instanceof String ? (String) value : null;
    }

    private static String firstTagValue(List<List<String>> tags, String name) {
        for (List<String> tag : tags) {
            if (tag.size() > 1 && name.equals(tag.get(0))) return tag.get(1);
        }
        return null;
    }

    private static List<List<String>> withoutTags(List<List<String>> tags, String name) {
        List<List<String>> out = new ArrayList<>();
        for (List<String> tag : tags) {
            if (!tag.isEmpty() && name.equals(tag.get(0))) continue;
            out.add(new ArrayList<>(tag));
        }
        return out;
    }

    private static final class EventTemplate {
        final String pubkey;
        final int kind;
        final long createdAt;
        final List<List<String>> tags;
        final String content;

        EventTemplate(String pubkey, int kind, long createdAt, List<List<String>> tags, String content) {
            this.pubkey = pubkey;
            this.kind = kind;
            this.createdAt = createdAt;
            this.tags = tags;
            this.content = content;
        }
    }
}
