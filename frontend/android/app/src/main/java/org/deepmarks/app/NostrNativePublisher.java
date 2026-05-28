package org.deepmarks.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class NostrNativePublisher {
    private static final String MOBILE_SIGNER_ACCOUNT_KEY = "deepmarks-mobile-signer-account:v1";
    private static final String API_BASE = "https://api.deepmarks.org";
    private static final String PUBLISH_URL = API_BASE + "/publish";
    private static final String CLIENT_HANDLER =
        "31990:2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4:deepmarks";

    private NostrNativePublisher() {}

    static void publishPublicBookmark(Context context, JSONObject share) throws Exception {
        Account account = loadAccount(context);
        if (account == null) throw new IllegalStateException("no matching signing key");
        String ownerPubkey = share.optString("ownerPubkey", "").trim().toLowerCase(Locale.ROOT);
        if (!account.pubkey.equals(ownerPubkey)) {
            throw new IllegalStateException("share belongs to a different account");
        }
        long createdAt = parseLong(share.optString("createdAt"), System.currentTimeMillis() / 1000L);
        long createdAtMs = parseLong(share.optString("createdAtMs"), createdAt * 1000L);
        String url = share.optString("url", "").trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw new IllegalArgumentException("only http(s) URLs can be shared");
        }

        List<List<String>> tags = new ArrayList<>();
        addTag(tags, "d", url);
        String title = share.optString("title", "").trim();
        addTag(tags, "title", title);
        String description = share.optString("description", "").trim();
        addTag(tags, "description", description);

        Set<String> normalizedTags = parseTags(share.optString("tags", ""));
        String readLater = share.optString("readLater", "");
        if (("1".equals(readLater) || "true".equals(readLater)) && !normalizedTags.contains("toread")) {
            normalizedTags.add("toread");
        }
        for (String tag : normalizedTags) addTag(tags, "t", tag);
        addTag(tags, "published_at", Long.toString(createdAt));
        if (createdAtMs > 0 && createdAtMs / 1000L == createdAt) {
            addTag(tags, "published_at_ms", Long.toString(createdAtMs));
        }
        addTag(tags, "client", "Deepmarks", CLIENT_HANDLER);

        NostrEventSigner.SignedEvent event = NostrEventSigner.signEvent(account.nsecHex, 39701, createdAt, tags, "");
        String eventJson = event.toJson();
        String body = "{\"events\":[" + eventJson + "]}";
        String auth = NostrEventSigner.buildNip98AuthHeader(account.nsecHex, PUBLISH_URL, "POST", body);
        postJson(PUBLISH_URL, body, auth);
    }

    static boolean canNativePublish(Context context, JSONObject share) {
        String visibility = share.optString("visibility", "private");
        if (!"public".equals(visibility)) return false;
        String ownerPubkey = share.optString("ownerPubkey", "").trim().toLowerCase(Locale.ROOT);
        if (!ownerPubkey.matches("^[0-9a-f]{64}$")) return false;
        try {
            Account account = loadAccount(context);
            return account != null && ownerPubkey.equals(account.pubkey);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static Account loadAccount(Context context) throws Exception {
        String raw = NativeSecureValueStore.get(context, MOBILE_SIGNER_ACCOUNT_KEY);
        if (raw == null) return null;
        JSONObject parsed = new JSONObject(raw);
        String nsecHex = parsed.optString("nsecHex", "").toLowerCase(Locale.ROOT);
        if (!nsecHex.matches("^[0-9a-f]{64}$")) return null;
        String pubkey = parsed.optString("pubkey", "").toLowerCase(Locale.ROOT);
        String derivedPubkey = NostrCrypto.publicKeyHex(nsecHex);
        if (!pubkey.matches("^[0-9a-f]{64}$")) pubkey = derivedPubkey;
        if (!derivedPubkey.equals(pubkey)) return null;
        return new Account(pubkey, nsecHex);
    }

    private static void postJson(String url, String body, String authHeader) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20_000);
            conn.setReadTimeout(20_000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            if (authHeader != null && !authHeader.isEmpty()) {
                conn.setRequestProperty("Authorization", authHeader);
            }
            conn.setRequestProperty("User-Agent", "Deepmarks Android Share");
            byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bodyBytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bodyBytes);
            }
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                String error = readAll(conn.getErrorStream());
                throw new IllegalStateException("publish " + status + (error.isEmpty() ? "" : ": " + error));
            }
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream input) {
        if (input == null) return "";
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return "";
        }
    }

    private static void addTag(List<List<String>> tags, String... parts) {
        List<String> row = new ArrayList<>();
        for (String part : parts) row.add(part);
        tags.add(row);
    }

    private static Set<String> parseTags(String raw) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String part : raw.split("[\\s,]+")) {
            String tag = part.trim().replaceFirst("^#+", "").toLowerCase(Locale.ROOT);
            if (tag.isEmpty() || tag.length() > 48) continue;
            out.add(tag);
        }
        return out;
    }

    private static long parseLong(String raw, long fallback) {
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static final class Account {
        final String pubkey;
        final String nsecHex;

        Account(String pubkey, String nsecHex) {
            this.pubkey = pubkey;
            this.nsecHex = nsecHex;
        }
    }
}
