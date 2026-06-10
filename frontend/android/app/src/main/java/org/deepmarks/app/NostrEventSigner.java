package org.deepmarks.app;

import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

final class NostrEventSigner {
    private NostrEventSigner() {}

    static SignedEvent signEvent(
        String nsecHex,
        int kind,
        long createdAt,
        List<List<String>> tags,
        String content
    ) throws Exception {
        String pubkey = NostrCrypto.publicKeyHex(nsecHex);
        String canonical = canonicalEvent(pubkey, createdAt, kind, tags, content);
        byte[] idBytes = NostrCrypto.sha256(canonical.getBytes(StandardCharsets.UTF_8));
        String id = NostrCrypto.hex(idBytes);
        String sig = NostrCrypto.schnorrSignHex(idBytes, nsecHex);
        return new SignedEvent(id, pubkey, createdAt, kind, tags, content, sig);
    }

    static String buildNip98AuthHeader(
        String nsecHex,
        String url,
        String method,
        String body
    ) throws Exception {
        byte[] payloadHash = NostrCrypto.sha256(body.getBytes(StandardCharsets.UTF_8));
        List<List<String>> tags = new java.util.ArrayList<>();
        tags.add(java.util.Arrays.asList("u", url));
        tags.add(java.util.Arrays.asList("method", method.toUpperCase(Locale.ROOT)));
        tags.add(java.util.Arrays.asList("nonce", UUID.randomUUID().toString()));
        tags.add(java.util.Arrays.asList("payload", NostrCrypto.hex(payloadHash)));
        SignedEvent auth = signEvent(nsecHex, 27235, System.currentTimeMillis() / 1000L, tags, "");
        String encoded = Base64.encodeToString(auth.toJson().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        return "Nostr " + encoded;
    }

    static String canonicalEvent(
        String pubkey,
        long createdAt,
        int kind,
        List<List<String>> tags,
        String content
    ) {
        return "[0," +
            jsonString(pubkey) + "," +
            createdAt + "," +
            kind + "," +
            jsonTags(tags) + "," +
            jsonString(content) +
            "]";
    }

    static String jsonTags(List<List<String>> tags) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < tags.size(); i++) {
            if (i > 0) out.append(',');
            out.append('[');
            List<String> row = tags.get(i);
            for (int j = 0; j < row.size(); j++) {
                if (j > 0) out.append(',');
                out.append(jsonString(row.get(j)));
            }
            out.append(']');
        }
        return out.append(']').toString();
    }

    static String jsonString(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.append('"').toString();
    }

    static final class SignedEvent {
        final String id;
        final String pubkey;
        final long createdAt;
        final int kind;
        final List<List<String>> tags;
        final String content;
        final String sig;

        SignedEvent(
            String id,
            String pubkey,
            long createdAt,
            int kind,
            List<List<String>> tags,
            String content,
            String sig
        ) {
            this.id = id;
            this.pubkey = pubkey;
            this.createdAt = createdAt;
            this.kind = kind;
            this.tags = tags;
            this.content = content;
            this.sig = sig;
        }

        String toJson() {
            return "{" +
                "\"id\":" + jsonString(id) + "," +
                "\"pubkey\":" + jsonString(pubkey) + "," +
                "\"created_at\":" + createdAt + "," +
                "\"kind\":" + kind + "," +
                "\"tags\":" + jsonTags(tags) + "," +
                "\"content\":" + jsonString(content) + "," +
                "\"sig\":" + jsonString(sig) +
                "}";
        }
    }
}
