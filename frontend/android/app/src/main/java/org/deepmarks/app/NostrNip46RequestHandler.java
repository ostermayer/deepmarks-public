package org.deepmarks.app;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class NostrNip46RequestHandler {
    static final int KIND = 24_133;

    private NostrNip46RequestHandler() {}

    static NostrEventSigner.SignedEvent handle(
        Account account,
        Connection connection,
        String requestEventJson
    ) throws Exception {
        return handle(account, connection, requestEventJson, System.currentTimeMillis() / 1000L);
    }

    static NostrEventSigner.SignedEvent handle(
        Account account,
        Connection connection,
        String requestEventJson,
        long responseCreatedAt
    ) throws Exception {
        Request request = verifiedRequest(account, connection, requestEventJson);
        if (request == null) return null;

        Response response;
        try {
            if (!permissionAllows(connection, request.method, request.params)) {
                throw new IllegalArgumentException("not authorized: " + request.method);
            }
            response = new Response(request.id, execute(account, connection, request));
        } catch (Exception e) {
            response = new Response(request.id, "error", e.getMessage());
        }
        return encryptResponse(account, connection.clientPubkey, response, responseCreatedAt);
    }

    static NostrEventSigner.SignedEvent errorResponse(
        Account account,
        Connection connection,
        String requestEventJson,
        String message,
        long responseCreatedAt
    ) throws Exception {
        Request request = verifiedRequest(account, connection, requestEventJson);
        if (request == null) return null;
        return encryptResponse(
            account,
            connection.clientPubkey,
            new Response(request.id, "error", message),
            responseCreatedAt
        );
    }

    static NostrEventSigner.SignedEvent approvedResponse(
        Account account,
        Connection connection,
        String requestEventJson,
        long responseCreatedAt
    ) throws Exception {
        Request request = verifiedRequest(account, connection, requestEventJson);
        if (request == null) return null;
        Response response;
        try {
            response = new Response(request.id, execute(account, connection, request));
        } catch (Exception e) {
            response = new Response(request.id, "error", e.getMessage());
        }
        return encryptResponse(account, connection.clientPubkey, response, responseCreatedAt);
    }

    static List<String> connectRequestedPermissions(
        Account account,
        Connection connection,
        String requestEventJson
    ) throws Exception {
        Request request = verifiedRequest(account, connection, requestEventJson);
        if (request == null || !request.method.equals("connect") || request.params.size() < 3) {
            return Collections.emptyList();
        }
        return parsePermissions(request.params.get(2));
    }

    static Request verifiedRequest(
        Account account,
        Connection connection,
        String requestEventJson
    ) throws Exception {
        IncomingEvent event;
        try {
            event = IncomingEvent.parse(requestEventJson);
        } catch (Exception ignored) {
            return null;
        }
        if (event.kind != KIND) return null;
        if (!event.pubkey.equals(connection.clientPubkey)) return null;
        if (!event.hasPTag(account.pubkey)) return null;
        if (!event.verify()) return null;

        try {
            return decryptRequest(account, event);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Request decryptRequest(Account account, IncomingEvent event) throws Exception {
        byte[] conversationKey = NostrNip44.conversationKey(account.nsecHex, event.pubkey);
        Map<String, Object> parsed = NostrJson.parseObject(NostrNip44.decrypt(event.content, conversationKey));
        String id = requiredString(parsed, "id");
        String method = requiredString(parsed, "method");
        Object rawParams = parsed.get("params");
        if (rawParams == null) throw new IllegalArgumentException("request params must be an array");
        if (!(rawParams instanceof List)) throw new IllegalArgumentException("request params must be an array");
        List<String> params = new ArrayList<>();
        for (Object value : (List<?>) rawParams) {
            if (!(value instanceof String)) throw new IllegalArgumentException("request params must be strings");
            params.add((String) value);
        }
        return new Request(id, method, params);
    }

    private static String execute(Account account, Connection connection, Request request) throws Exception {
        switch (request.method) {
            case "connect":
                return request.params.size() > 1 ? request.params.get(1) : "ack";
            case "get_public_key":
                return account.pubkey;
            case "ping":
                return "pong";
            case "switch_relays":
                return NostrJson.stringify(connection.relays);
            case "sign_event":
                return signEventParam(account, request.params.isEmpty() ? null : request.params.get(0));
            case "nip04_encrypt":
                assertParamCount(request.method, request.params, 2);
                return NostrNip04.encrypt(account.nsecHex, request.params.get(0), request.params.get(1));
            case "nip04_decrypt":
                assertParamCount(request.method, request.params, 2);
                return NostrNip04.decrypt(account.nsecHex, request.params.get(0), request.params.get(1));
            case "nip44_encrypt":
                assertParamCount(request.method, request.params, 2);
                return NostrNip44.encrypt(
                    request.params.get(1),
                    NostrNip44.conversationKey(account.nsecHex, request.params.get(0))
                );
            case "nip44_decrypt":
                assertParamCount(request.method, request.params, 2);
                return NostrNip44.decrypt(
                    request.params.get(1),
                    NostrNip44.conversationKey(account.nsecHex, request.params.get(0))
                );
            default:
                throw new IllegalArgumentException("unsupported method: " + request.method);
        }
    }

    private static void assertParamCount(String method, List<String> params, int count) {
        if (params.size() != count) {
            throw new IllegalArgumentException(method + " expects " + count + " params");
        }
    }

    private static String signEventParam(Account account, String raw) throws Exception {
        if (raw == null || raw.isEmpty()) throw new IllegalArgumentException("sign_event expects an event template");
        Map<String, Object> parsed = NostrJson.parseObject(raw);
        int kind = parseKind(parsed);
        List<List<String>> tags = parseTags(parsed.get("tags"));
        Object contentValue = parsed.get("content");
        if (contentValue != null && !(contentValue instanceof String)) {
            throw new IllegalArgumentException("event.content must be a string");
        }
        long createdAt = parsed.containsKey("created_at") ? parseIntegerLong(parsed, "created_at") : System.currentTimeMillis() / 1000L;
        NostrEventSigner.SignedEvent signed = NostrEventSigner.signEvent(
            account.nsecHex,
            kind,
            createdAt,
            tags,
            contentValue instanceof String ? (String) contentValue : ""
        );
        return signed.toJson();
    }

    private static boolean permissionAllows(Connection connection, String method, List<String> params) {
        if (connection.trustLevel.equals(Connection.TRUST_FULL)) return true;
        if (
            method.equals("connect") ||
            method.equals("get_public_key") ||
            method.equals("ping") ||
            method.equals("switch_relays")
        ) {
            return true;
        }
        Set<String> perms = new HashSet<>(connection.perms);
        if (method.equals("sign_event")) {
            Integer kind = signEventKind(params.isEmpty() ? null : params.get(0));
            return perms.contains("sign_event") || (kind != null && perms.contains("sign_event:" + kind));
        }
        return perms.contains(method);
    }

    private static Integer signEventKind(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            Map<String, Object> parsed = NostrJson.parseObject(raw);
            if (!parsed.containsKey("kind")) return null;
            int kind = parseKind(parsed);
            return kind;
        } catch (Exception ignored) {
            return null;
        }
    }

    static String permissionForRequest(Request request) {
        if (request.method.equals("sign_event")) {
            Integer kind = signEventKind(request.params.isEmpty() ? null : request.params.get(0));
            return kind == null ? "sign_event" : "sign_event:" + kind;
        }
        return request.method;
    }

    private static List<String> parsePermissions(String raw) {
        if (raw == null || raw.isEmpty()) return Collections.emptyList();
        Set<String> out = new LinkedHashSet<>();
        for (String part : raw.split(",")) {
            String perm = part.trim();
            if (!perm.isEmpty()) out.add(perm);
        }
        return new ArrayList<>(out);
    }

    private static NostrEventSigner.SignedEvent encryptResponse(
        Account account,
        String clientPubkey,
        Response response,
        long createdAt
    ) throws Exception {
        byte[] conversationKey = NostrNip44.conversationKey(account.nsecHex, clientPubkey);
        String content = NostrNip44.encrypt(response.toJson(), conversationKey);
        List<List<String>> tags = new ArrayList<>();
        List<String> p = new ArrayList<>();
        p.add("p");
        p.add(clientPubkey);
        tags.add(p);
        return NostrEventSigner.signEvent(account.nsecHex, KIND, createdAt, tags, content);
    }

    private static String requiredString(Map<String, Object> obj, String key) {
        Object value = obj.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty()) {
            throw new IllegalArgumentException("request is missing " + key);
        }
        return (String) value;
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

    private static List<List<String>> parseTags(Object rawTags) throws Exception {
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

    static final class Account {
        final String pubkey;
        final String nsecHex;

        Account(String nsecHex) {
            this(NostrCrypto.publicKeyHex(nsecHex), nsecHex);
        }

        Account(String pubkey, String nsecHex) {
            this.pubkey = pubkey;
            this.nsecHex = nsecHex;
        }
    }

    static final class Connection {
        final String clientPubkey;
        final List<String> relays;
        final List<String> perms;
        final String name;
        final String url;
        final String image;
        final String trustLevel;

        static final String TRUST_FULL = "full";
        static final String TRUST_MEDIUM = "medium";
        static final String TRUST_LOW = "low";
        static final String TRUST_UNSET = "unset";

        Connection(String clientPubkey, List<String> relays, List<String> perms) {
            this(clientPubkey, relays, perms, "", "", "", TRUST_LOW);
        }

        Connection(
            String clientPubkey,
            List<String> relays,
            List<String> perms,
            String name,
            String url,
            String image,
            String trustLevel
        ) {
            this.clientPubkey = clientPubkey;
            this.relays = relays;
            this.perms = perms;
            this.name = name == null ? "" : name;
            this.url = url == null ? "" : url;
            this.image = image == null ? "" : image;
            this.trustLevel = normalizeTrust(trustLevel);
        }

        Connection withPermsAndTrust(List<String> nextPerms, String nextTrustLevel) {
            return new Connection(clientPubkey, relays, nextPerms, name, url, image, nextTrustLevel);
        }

        static String normalizeTrust(String trustLevel) {
            if (TRUST_FULL.equals(trustLevel) || TRUST_MEDIUM.equals(trustLevel) || TRUST_LOW.equals(trustLevel)) {
                return trustLevel;
            }
            return TRUST_UNSET;
        }
    }

    static final class IncomingEvent {
        final String id;
        final String pubkey;
        final long createdAt;
        final int kind;
        final List<List<String>> tags;
        final String content;
        final String sig;

        IncomingEvent(String id, String pubkey, long createdAt, int kind, List<List<String>> tags, String content, String sig) {
            this.id = id;
            this.pubkey = pubkey;
            this.createdAt = createdAt;
            this.kind = kind;
            this.tags = tags;
            this.content = content;
            this.sig = sig;
        }

        static IncomingEvent parse(String json) throws Exception {
            Map<String, Object> obj = NostrJson.parseObject(json);
            return new IncomingEvent(
                requiredString(obj, "id"),
                requiredString(obj, "pubkey"),
                parseIntegerLong(obj, "created_at"),
                parseKind(obj),
                parseTags(obj.get("tags")),
                requiredString(obj, "content"),
                requiredString(obj, "sig")
            );
        }

        boolean verify() throws Exception {
            String canonical = NostrEventSigner.canonicalEvent(pubkey, createdAt, kind, tags, content);
            byte[] idBytes = NostrCrypto.sha256(canonical.getBytes(StandardCharsets.UTF_8));
            String computed = NostrCrypto.hex(idBytes);
            return computed.equals(id) && NostrCrypto.schnorrVerify(idBytes, pubkey, sig);
        }

        boolean hasPTag(String target) {
            for (List<String> tag : tags) {
                if (tag.size() >= 2 && tag.get(0).equals("p") && tag.get(1).equals(target)) return true;
            }
            return false;
        }
    }

    static final class Response {
        final String id;
        final String result;
        final String error;

        Response(String id, String result) {
            this(id, result, null);
        }

        Response(String id, String result, String error) {
            this.id = id;
            this.result = result;
            this.error = error;
        }

        String toJson() {
            StringBuilder out = new StringBuilder("{");
            out.append("\"id\":").append(NostrEventSigner.jsonString(id));
            out.append(",\"result\":").append(NostrEventSigner.jsonString(result));
            if (error != null) out.append(",\"error\":").append(NostrEventSigner.jsonString(error));
            return out.append("}").toString();
        }
    }

    static final class Request {
        final String id;
        final String method;
        final List<String> params;

        Request(String id, String method, List<String> params) {
            this.id = id;
            this.method = method;
            this.params = params;
        }
    }
}
