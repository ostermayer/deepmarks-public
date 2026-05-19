package org.deepmarks.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Receives Android share-sheet intents (ACTION_SEND with text/plain)
 * and translates the incoming URL into our internal scheme so the
 * Capacitor App plugin's appUrlOpen listener fires uniformly across
 * the share-sheet path, custom-scheme deep links, and (eventually)
 * Universal Links.
 *
 * Why this bridge: Capacitor doesn't surface raw Intent extras to the
 * JS side. The cleanest path to keep ALL deep-link handling in
 * frontend/src/lib/native/deep-links.ts is to convert the share-sheet
 * intent into a deepmarks://save?url=... and re-broadcast — that
 * matches the iOS Share Extension flow and means the JS side has
 * exactly one code path to maintain.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeepmarksSecureStorePlugin.class);
        super.onCreate(savedInstanceState);
        handleNostrSignerIntent(getIntent());
        handleShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleNostrSignerIntent(intent);
        handleShareIntent(intent);
    }

    private void handleNostrSignerIntent(Intent intent) {
        if (!NostrSignerIntentStore.isNostrSignerIntent(intent)) return;
        try {
            String requestId = NostrSignerIntentStore.savePending(this, intent);
            Uri appUri = Uri.parse("deepmarks://signer?androidRequest=" + Uri.encode(requestId));
            Intent forwarded = new Intent(Intent.ACTION_VIEW, appUri);
            forwarded.setPackage(getPackageName());
            setIntent(forwarded);
        } catch (Exception ignored) {
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    /**
     * If the intent that started us is a SEND text/plain (browser
     * "Share → Deepmarks"), pull the URL out, wrap it in our internal
     * scheme, and replace the activity's intent so Capacitor's
     * appUrlOpen listener picks it up on the next bridge tick.
     */
    private void handleShareIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String type = intent.getType();
        if (!Intent.ACTION_SEND.equals(action) || !"text/plain".equals(type)) return;

        String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (shared == null) return;
        shared = shared.trim();
        if (shared.isEmpty()) return;

        // Browsers vary: Chrome sends "https://example.com/article",
        // Firefox sometimes sends "Title\nhttps://example.com/article".
        // Find the last http(s) URL in the payload and forward only
        // that — anything else is metadata the user can re-enter in
        // the form.
        String url = extractFirstHttpUrl(shared);
        if (url == null) return;

        Uri appUri = Uri.parse("deepmarks://save?url=" + Uri.encode(url));
        Intent forwarded = new Intent(Intent.ACTION_VIEW, appUri);
        // Keep the package + activity scoped to ourselves so we don't
        // launch a second instance in another task.
        forwarded.setPackage(getPackageName());
        setIntent(forwarded);
    }

    private static String extractFirstHttpUrl(String text) {
        // Cheap scan: walk tokens, return the first https?:// match.
        // Avoids pulling a regex for what is almost always a single-
        // token share payload.
        for (String token : text.split("\\s+")) {
            String t = token.trim();
            if (t.startsWith("http://") || t.startsWith("https://")) return t;
        }
        return null;
    }
}
