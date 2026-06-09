package org.deepmarks.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.UUID;

final class Nip46ForegroundApprovalStore {
    private static final String PREFS = "deepmarks_nip46_foreground_approvals";
    private static final String PENDING_KEY = "pending";
    private static final String REQUEST_EVENT_KEY = "requestEvent";

    private Nip46ForegroundApprovalStore() {}

    static String savePending(
        Context context,
        NostrNip46RequestHandler.Account account,
        NostrNip46RequestHandler.Connection connection,
        NostrNip46RequestHandler.Request request,
        String requestEventJson,
        List<String> requestedPerms
    ) throws JSONException {
        String requestId = UUID.randomUUID().toString();
        JSONObject pending = new JSONObject();
        pending.put("requestId", requestId);
        pending.put("clientPubkey", connection.clientPubkey);
        pending.put("clientName", connection.name);
        pending.put("clientUrl", connection.url);
        pending.put("clientImage", connection.image);
        pending.put("accountPubkey", account.pubkey);
        pending.put("method", request.method);
        pending.put("permission", NostrNip46RequestHandler.permissionForRequest(request));
        pending.put("permissions", new JSONArray(requestedPerms));
        pending.put("trustLevel", connection.trustLevel);
        pending.put("createdAt", System.currentTimeMillis() / 1000L);
        pending.put(REQUEST_EVENT_KEY, requestEventJson);
        addEventPreview(pending, request);
        prefs(context).edit().putString(PENDING_KEY, pending.toString()).apply();
        return requestId;
    }

    static JSONObject getPending(Context context) throws JSONException {
        String raw = prefs(context).getString(PENDING_KEY, null);
        return raw == null ? null : new JSONObject(raw);
    }

    static JSONObject getPendingForUi(Context context) throws JSONException {
        JSONObject pending = getPending(context);
        if (pending == null) return null;
        JSONObject out = new JSONObject(pending.toString());
        out.remove(REQUEST_EVENT_KEY);
        return out;
    }

    static String requestEvent(JSONObject pending) {
        return pending == null ? "" : pending.optString(REQUEST_EVENT_KEY, "");
    }

    static void clear(Context context, String requestId) throws JSONException {
        JSONObject pending = getPending(context);
        if (pending == null || !requestId.equals(pending.optString("requestId"))) return;
        prefs(context).edit().remove(PENDING_KEY).apply();
    }

    private static void addEventPreview(JSONObject pending, NostrNip46RequestHandler.Request request) throws JSONException {
        if (!"sign_event".equals(request.method) || request.params.isEmpty()) return;
        try {
            JSONObject event = new JSONObject(request.params.get(0));
            pending.put("eventKind", event.optInt("kind"));
            pending.put("eventContent", event.optString("content", ""));
        } catch (Exception ignored) {
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
