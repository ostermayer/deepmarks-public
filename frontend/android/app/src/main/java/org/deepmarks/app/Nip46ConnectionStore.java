package org.deepmarks.app;

import android.content.Context;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class Nip46ConnectionStore {
    static final String ACCOUNT_KEY = "deepmarks-mobile-signer-account:v1";
    static final String CONNECTIONS_KEY = "deepmarks-mobile-signer-connections:v1";
    static final String ENABLED_KEY = "deepmarks-mobile-signer-foreground-enabled:v1";

    private Nip46ConnectionStore() {}

    static NostrNip46RequestHandler.Account loadAccount(Context context) throws Exception {
        return parseAccount(NativeSecureValueStore.get(context, ACCOUNT_KEY));
    }

    static List<NostrNip46RequestHandler.Connection> loadConnections(Context context) throws Exception {
        return parseConnections(NativeSecureValueStore.get(context, CONNECTIONS_KEY));
    }

    static boolean isEnabled(Context context) {
        try {
            return "1".equals(NativeSecureValueStore.get(context, ENABLED_KEY));
        } catch (Exception ignored) {
            return false;
        }
    }

    static void setEnabled(Context context, boolean enabled) throws Exception {
        NativeSecureValueStore.set(context, ENABLED_KEY, enabled ? "1" : "0");
    }

    static void touchConnection(Context context, String clientPubkey, long lastSeenAt) throws Exception {
        String raw = NativeSecureValueStore.get(context, CONNECTIONS_KEY);
        Object parsed = raw == null || raw.isEmpty() ? null : NostrJson.parse(raw);
        if (!(parsed instanceof List)) return;
        boolean changed = false;
        List<Object> next = new ArrayList<>();
        for (Object entry : (List<?>) parsed) {
            if (!(entry instanceof Map)) {
                next.add(entry);
                continue;
            }
            Map<String, Object> map = new LinkedHashMap<>();
            for (Map.Entry<?, ?> item : ((Map<?, ?>) entry).entrySet()) {
                if (item.getKey() instanceof String) map.put((String) item.getKey(), item.getValue());
            }
            Object pubkey = map.get("clientPubkey");
            if (pubkey instanceof String && ((String) pubkey).equals(clientPubkey)) {
                map.put("lastSeenAt", lastSeenAt);
                changed = true;
            }
            next.add(map);
        }
        if (changed) NativeSecureValueStore.set(context, CONNECTIONS_KEY, NostrJson.stringify(next));
    }

    static NostrNip46RequestHandler.Connection updateConnectionApproval(
        Context context,
        String clientPubkey,
        List<String> requestedPerms,
        String trustLevel
    ) throws Exception {
        String raw = NativeSecureValueStore.get(context, CONNECTIONS_KEY);
        Object parsed = raw == null || raw.isEmpty() ? null : NostrJson.parse(raw);
        if (!(parsed instanceof List)) return null;

        boolean changed = false;
        List<Object> next = new ArrayList<>();
        for (Object entry : (List<?>) parsed) {
            if (!(entry instanceof Map)) {
                next.add(entry);
                continue;
            }
            Map<String, Object> map = new LinkedHashMap<>();
            for (Map.Entry<?, ?> item : ((Map<?, ?>) entry).entrySet()) {
                if (item.getKey() instanceof String) map.put((String) item.getKey(), item.getValue());
            }
            Object pubkey = map.get("clientPubkey");
            if (pubkey instanceof String && ((String) pubkey).equals(clientPubkey)) {
                List<String> merged = mergePerms(stringList(map.get("perms")), requestedPerms);
                if (!merged.equals(stringList(map.get("perms")))) {
                    map.put("perms", merged);
                    changed = true;
                }
                String normalizedTrust = NostrNip46RequestHandler.Connection.normalizeTrust(trustLevel);
                if (!normalizedTrust.equals(stringValue(map.get("trustLevel")))) {
                    map.put("trustLevel", normalizedTrust);
                    changed = true;
                }
                map.put("lastSeenAt", System.currentTimeMillis() / 1000L);
            }
            next.add(map);
        }
        String updated = NostrJson.stringify(next);
        if (changed) NativeSecureValueStore.set(context, CONNECTIONS_KEY, updated);
        return findConnection(parseConnections(updated), clientPubkey);
    }

    static NostrNip46RequestHandler.Account parseAccount(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        Map<String, Object> parsed = NostrJson.parseObject(raw);
        String pubkey = stringValue(parsed.get("pubkey"));
        String nsecHex = stringValue(parsed.get("nsecHex"));
        if (!isHex64(pubkey) || !isHex64(nsecHex)) return null;
        String derived = NostrCrypto.publicKeyHex(nsecHex);
        if (!derived.equals(pubkey)) return null;
        return new NostrNip46RequestHandler.Account(pubkey, nsecHex);
    }

    static List<NostrNip46RequestHandler.Connection> parseConnections(String raw) {
        List<NostrNip46RequestHandler.Connection> out = new ArrayList<>();
        if (raw == null || raw.isEmpty()) return out;
        Object parsed = NostrJson.parse(raw);
        if (!(parsed instanceof List)) return out;
        for (Object entry : (List<?>) parsed) {
            if (!(entry instanceof Map)) continue;
            Map<?, ?> map = (Map<?, ?>) entry;
            String clientPubkey = stringValue(map.get("clientPubkey"));
            String secret = stringValue(map.get("secret"));
            if (!isHex64(clientPubkey) || secret == null || secret.isEmpty()) continue;
            List<String> relays = normalizeRelayList(map.get("relays"));
            if (relays.isEmpty()) continue;
            out.add(new NostrNip46RequestHandler.Connection(
                clientPubkey,
                relays,
                stringList(map.get("perms")),
                stringValue(map.get("name")),
                stringValue(map.get("url")),
                stringValue(map.get("image")),
                stringValue(map.get("trustLevel"))
            ));
        }
        return out;
    }

    static List<String> mergePerms(List<String> existing, List<String> requested) {
        Set<String> out = new LinkedHashSet<>();
        for (String item : existing) {
            String clean = item == null ? "" : item.trim();
            if (!clean.isEmpty()) out.add(clean);
        }
        for (String item : requested) {
            String clean = item == null ? "" : item.trim();
            if (!clean.isEmpty()) out.add(clean);
        }
        return new ArrayList<>(out);
    }

    static List<String> relayUnion(List<NostrNip46RequestHandler.Connection> connections) {
        List<String> out = new ArrayList<>();
        for (NostrNip46RequestHandler.Connection connection : connections) {
            for (String relay : connection.relays) {
                if (!out.contains(relay)) out.add(relay);
            }
        }
        return out;
    }

    static NostrNip46RequestHandler.Connection findConnection(
        List<NostrNip46RequestHandler.Connection> connections,
        String clientPubkey
    ) {
        for (NostrNip46RequestHandler.Connection connection : connections) {
            if (connection.clientPubkey.equals(clientPubkey)) return connection;
        }
        return null;
    }

    private static List<String> normalizeRelayList(Object raw) {
        List<String> out = new ArrayList<>();
        if (!(raw instanceof List)) return out;
        for (Object value : (List<?>) raw) {
            String relay = stringValue(value);
            if (relay == null) continue;
            relay = relay.trim().replaceAll("/+$", "");
            String lower = relay.toLowerCase(Locale.ROOT);
            if (!(lower.startsWith("wss://") || lower.startsWith("ws://"))) continue;
            if (out.contains(relay)) continue;
            out.add(relay);
        }
        return out;
    }

    private static List<String> stringList(Object raw) {
        List<String> out = new ArrayList<>();
        if (!(raw instanceof List)) return out;
        for (Object value : (List<?>) raw) {
            String item = stringValue(value);
            if (item == null || item.trim().isEmpty()) continue;
            out.add(item.trim());
        }
        return out;
    }

    private static String stringValue(Object value) {
        return value instanceof String ? (String) value : null;
    }

    private static boolean isHex64(String value) {
        return value != null && value.matches("^[0-9a-f]{64}$");
    }
}
