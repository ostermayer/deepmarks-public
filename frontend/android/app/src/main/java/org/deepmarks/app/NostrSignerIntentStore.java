package org.deepmarks.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

final class NostrSignerIntentStore {
    static final String PREFS = "deepmarks_nostr_signer_intents";
    static final String PENDING_KEY = "pending";

    private NostrSignerIntentStore() {}

    static boolean isNostrSignerIntent(Intent intent) {
        if (intent == null) return false;
        Uri data = intent.getData();
        return Intent.ACTION_VIEW.equals(intent.getAction())
            && data != null
            && "nostrsigner".equals(data.getScheme());
    }

    static String savePending(Context context, Intent intent) throws JSONException {
        String requestId = UUID.randomUUID().toString();
        Uri data = intent.getData();
        JSONObject request = new JSONObject();
        request.put("requestId", requestId);
        request.put("rawUrl", data == null ? "" : data.toString());
        request.put("content", signerContent(data));
        request.put("type", value(intent, data, "type", "get_public_key"));
        putIfPresent(request, "id", value(intent, data, "id", null));
        putIfPresent(request, "pubkey", value(intent, data, "pubkey", null));
        putIfPresent(request, "currentUser", value(intent, data, "current_user", null));
        putIfPresent(request, "permissions", value(intent, data, "permissions", null));
        putIfPresent(request, "returnType", value(intent, data, "returnType", null));
        putIfPresent(request, "callbackUrl", value(intent, data, "callbackUrl", null));
        prefs(context).edit().putString(PENDING_KEY, request.toString()).apply();
        return requestId;
    }

    static JSONObject getPending(Context context) throws JSONException {
        String raw = prefs(context).getString(PENDING_KEY, null);
        return raw == null ? null : new JSONObject(raw);
    }

    static void clear(Context context) {
        prefs(context).edit().remove(PENDING_KEY).apply();
    }

    static void complete(Activity activity, String requestId, String result, String id, String event) throws JSONException {
        JSONObject pending = getPending(activity);
        if (pending == null || !requestId.equals(pending.optString("requestId"))) return;
        Intent data = new Intent();
        data.putExtra("result", result);
        data.putExtra("package", activity.getPackageName());
        if (id != null && !id.isEmpty()) data.putExtra("id", id);
        if (event != null && !event.isEmpty()) data.putExtra("event", event);
        activity.setResult(Activity.RESULT_OK, data);
        clear(activity);
        activity.finish();
    }

    static void reject(Activity activity, String requestId) throws JSONException {
        JSONObject pending = getPending(activity);
        if (pending == null || !requestId.equals(pending.optString("requestId"))) return;
        activity.setResult(Activity.RESULT_CANCELED);
        clear(activity);
        activity.finish();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void putIfPresent(JSONObject target, String key, String value) throws JSONException {
        if (value != null) target.put(key, value);
    }

    private static String value(Intent intent, Uri data, String name, String fallback) {
        String extra = intent.getStringExtra(name);
        if (extra != null) return extra;
        return data == null ? fallback : data.getQueryParameter(name) != null ? data.getQueryParameter(name) : fallback;
    }

    private static String signerContent(Uri data) {
        if (data == null) return "";
        String raw = data.toString();
        String prefix = "nostrsigner:";
        if (!raw.startsWith(prefix)) return "";
        String content = raw.substring(prefix.length());
        int query = content.indexOf('?');
        if (query >= 0) content = content.substring(0, query);
        return Uri.decode(content);
    }
}
