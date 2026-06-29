package org.deepmarks.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class NostrSignerTrustStore {
    static final String PREFS = "deepmarks_nostr_signer_trust";
    static final String TRUST_FULL = "full";
    static final String TRUST_MEDIUM = "medium";
    static final String TRUST_LOW = "low";

    private NostrSignerTrustStore() {}

    static String getLevel(Context context, String appId) {
        if (appId == null || appId.isEmpty()) return "";
        String raw = prefs(context).getString(appId, null);
        if (raw == null || raw.isEmpty()) return "";
        String plain = normalize(raw);
        if (!plain.isEmpty()) return plain;
        try {
            return normalize(new JSONObject(raw).optString("level", ""));
        } catch (JSONException ignored) {
            return "";
        }
    }

    static void set(Context context, String appId, String level, String requesterName) throws JSONException {
        String normalized = normalize(level);
        if (appId == null || appId.isEmpty() || normalized.isEmpty()) {
            throw new IllegalArgumentException("valid appId and trust level are required");
        }
        JSONObject value = new JSONObject();
        value.put("level", normalized);
        value.put("requesterPackage", appId);
        value.put("requesterName", requesterName == null ? "" : requesterName);
        value.put("updatedAt", System.currentTimeMillis());
        prefs(context).edit().putString(appId, value.toString()).commit();
    }

    static void remove(Context context, String appId) {
        if (appId == null || appId.isEmpty()) return;
        prefs(context).edit().remove(appId).commit();
    }

    static JSONArray list(Context context) throws JSONException {
        JSONArray out = new JSONArray();
        for (String appId : prefs(context).getAll().keySet()) {
            String raw = prefs(context).getString(appId, "");
            String level = normalize(raw);
            String requesterName = "";
            long updatedAt = 0L;
            if (level.isEmpty()) {
                try {
                    JSONObject parsed = new JSONObject(raw);
                    level = normalize(parsed.optString("level", ""));
                    requesterName = parsed.optString("requesterName", "");
                    updatedAt = parsed.optLong("updatedAt", 0L);
                } catch (JSONException ignored) {
                    level = "";
                }
            }
            if (level.isEmpty()) continue;
            JSONObject item = new JSONObject();
            item.put("appId", appId);
            item.put("appName", requesterName.isEmpty() ? appId : requesterName);
            item.put("level", level);
            item.put("updatedAt", updatedAt);
            out.put(item);
        }
        return out;
    }

    static boolean allowsBackground(Context context, String appId, String method, String eventJson) {
        String level = getLevel(context, appId);
        if (TRUST_FULL.equals(level)) return true;
        if (!TRUST_MEDIUM.equals(level)) return false;
        return "get_public_key".equals(method) || isCommonAuthEvent(eventJson);
    }

    static String normalize(String level) {
        if (TRUST_FULL.equals(level) || TRUST_MEDIUM.equals(level) || TRUST_LOW.equals(level)) {
            return level;
        }
        return "";
    }

    private static boolean isCommonAuthEvent(String eventJson) {
        if (eventJson == null || eventJson.isEmpty()) return false;
        try {
            Object kind = NostrJson.parseObject(eventJson).get("kind");
            if (!(kind instanceof Number)) return false;
            int value = ((Number) kind).intValue();
            return value == 22242 || value == 27235;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
