package org.deepmarks.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

final class PendingShareStore {
    private static final String PREFS = "deepmarks_share_store";
    private static final String PENDING_KEY = "deepmarks-pending-shares-v1";
    private static final String DEFAULT_VISIBILITY_KEY = "defaultVisibility";
    private static final String DEFAULT_READ_LATER_KEY = "defaultReadLater";
    private static final String DEFAULT_TAGS_KEY = "defaultTags";
    private static final String ACTIVE_PUBKEY_KEY = "activePubkey";
    private static final String USER_TAGS_KEY = "userTags";
    private static final int MAX_PENDING = 50;

    private PendingShareStore() {}

    static JSONObject buildShare(
        Context context,
        String url,
        String title,
        String description
    ) throws JSONException {
        ShareDefaults defaults = readDefaults(context);
        long nowMs = System.currentTimeMillis();
        JSONObject share = new JSONObject();
        share.put("id", UUID.randomUUID().toString());
        share.put("url", url);
        share.put("title", title == null ? "" : title);
        share.put("description", description == null ? "" : description);
        share.put("tags", defaults.defaultTags);
        share.put("readLater", defaults.defaultReadLater ? "1" : "");
        share.put("visibility", defaults.defaultVisibility);
        share.put("ownerPubkey", defaults.activePubkey);
        share.put("autosave", "1");
        share.put("createdAt", Long.toString(nowMs / 1000L));
        share.put("createdAtMs", Long.toString(nowMs));
        return share;
    }

    static void append(Context context, JSONObject share) throws JSONException {
        JSONArray shares = load(context);
        String id = share.optString("id", "");
        JSONArray next = new JSONArray();
        for (int i = 0; i < shares.length(); i++) {
            JSONObject item = shares.optJSONObject(i);
            if (item == null) continue;
            if (!id.isEmpty() && id.equals(item.optString("id"))) continue;
            next.put(item);
        }
        next.put(share);
        while (next.length() > MAX_PENDING) {
            JSONArray trimmed = new JSONArray();
            for (int i = 1; i < next.length(); i++) trimmed.put(next.get(i));
            next = trimmed;
        }
        prefs(context).edit().putString(PENDING_KEY, next.toString()).apply();
    }

    static JSONObject get(Context context, String id) {
        JSONArray shares = load(context);
        if (id != null && !id.isEmpty()) {
            for (int i = 0; i < shares.length(); i++) {
                JSONObject item = shares.optJSONObject(i);
                if (item != null && id.equals(item.optString("id"))) return item;
            }
            return null;
        }
        return shares.length() > 0 ? shares.optJSONObject(0) : null;
    }

    static void remove(Context context, String id) throws JSONException {
        if (id == null || id.isEmpty()) return;
        JSONArray shares = load(context);
        JSONArray next = new JSONArray();
        for (int i = 0; i < shares.length(); i++) {
            JSONObject item = shares.optJSONObject(i);
            if (item == null || id.equals(item.optString("id"))) continue;
            next.put(item);
        }
        prefs(context).edit().putString(PENDING_KEY, next.toString()).apply();
    }

    static void markPublished(Context context, String id) throws JSONException {
        if (id == null || id.isEmpty()) return;
        JSONArray shares = load(context);
        for (int i = 0; i < shares.length(); i++) {
            JSONObject item = shares.optJSONObject(i);
            if (item != null && id.equals(item.optString("id"))) {
                item.put("published", "1");
            }
        }
        prefs(context).edit().putString(PENDING_KEY, shares.toString()).apply();
    }

    static void writeDefaults(
        Context context,
        String defaultVisibility,
        boolean defaultReadLater,
        JSONArray defaultTags,
        String activePubkey
    ) {
        String visibility = "public".equals(defaultVisibility) ? "public" : "private";
        String tags = normalizeTags(defaultTags);
        String pubkey = normalizePubkey(activePubkey);
        prefs(context).edit()
            .putString(DEFAULT_VISIBILITY_KEY, visibility)
            .putBoolean(DEFAULT_READ_LATER_KEY, defaultReadLater)
            .putString(DEFAULT_TAGS_KEY, tags)
            .putString(ACTIVE_PUBKEY_KEY, pubkey)
            .apply();
    }

    static ShareDefaults readDefaults(Context context) {
        SharedPreferences prefs = prefs(context);
        return new ShareDefaults(
            prefs.getString(DEFAULT_VISIBILITY_KEY, "private"),
            prefs.getBoolean(DEFAULT_READ_LATER_KEY, false),
            prefs.getString(DEFAULT_TAGS_KEY, ""),
            prefs.getString(ACTIVE_PUBKEY_KEY, "")
        );
    }

    static void writeUserTags(Context context, JSONArray raw) {
        JSONArray cleaned = new JSONArray();
        if (raw != null) {
            for (int i = 0; i < raw.length() && cleaned.length() < 400; i++) {
                String tag = raw.optString(i, "")
                    .trim()
                    .replaceFirst("^#+", "")
                    .toLowerCase(Locale.ROOT);
                if (tag.isEmpty() || tag.length() > 48) continue;
                cleaned.put(tag);
            }
        }
        prefs(context).edit().putString(USER_TAGS_KEY, cleaned.toString()).apply();
    }

    static List<String> readUserTags(Context context) {
        String raw = prefs(context).getString(USER_TAGS_KEY, "[]");
        List<String> tags = new ArrayList<>();
        try {
            JSONArray parsed = new JSONArray(raw);
            for (int i = 0; i < parsed.length(); i++) {
                String tag = parsed.optString(i, "").trim().toLowerCase(Locale.ROOT);
                if (!tag.isEmpty() && tag.length() <= 48) tags.add(tag);
            }
        } catch (JSONException ignored) {
            prefs(context).edit().remove(USER_TAGS_KEY).apply();
        }
        return tags;
    }

    private static JSONArray load(Context context) {
        String raw = prefs(context).getString(PENDING_KEY, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException ignored) {
            prefs(context).edit().remove(PENDING_KEY).apply();
            return new JSONArray();
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String normalizeTags(JSONArray raw) {
        if (raw == null) return "";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < raw.length() && i < 40; i++) {
            String tag = raw.optString(i, "")
                .trim()
                .replaceFirst("^#+", "")
                .toLowerCase(Locale.ROOT);
            if (tag.isEmpty() || tag.length() > 48) continue;
            if (out.length() > 0) out.append(' ');
            out.append(tag);
        }
        return out.toString();
    }

    private static String normalizePubkey(String raw) {
        String pubkey = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        return pubkey.matches("^[0-9a-f]{64}$") ? pubkey : "";
    }

    static final class ShareDefaults {
        final String defaultVisibility;
        final boolean defaultReadLater;
        final String defaultTags;
        final String activePubkey;

        ShareDefaults(String defaultVisibility, boolean defaultReadLater, String defaultTags, String activePubkey) {
            this.defaultVisibility = "public".equals(defaultVisibility) ? "public" : "private";
            this.defaultReadLater = defaultReadLater;
            this.defaultTags = defaultTags == null ? "" : defaultTags;
            this.activePubkey = normalizePubkey(activePubkey);
        }
    }
}
