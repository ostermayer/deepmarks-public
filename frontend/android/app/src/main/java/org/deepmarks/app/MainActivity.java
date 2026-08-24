package org.deepmarks.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Main Capacitor shell. Share-sheet saves are handled by ShareActivity
 * so Android can mirror the iOS extension's native sign-and-POST path
 * without opening the full app UI for public saves.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeepmarksSecureStorePlugin.class);
        registerPlugin(Nip46ServiceControllerPlugin.class);
        Intent normalized = normalizeIncomingIntent(getIntent());
        if (normalized != null) setIntent(normalized);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        Intent normalized = normalizeIncomingIntent(intent);
        if (normalized == null) return;
        super.onNewIntent(normalized);
        setIntent(normalized);
    }

    private Intent normalizeIncomingIntent(Intent intent) {
        if (intent == null) return null;
        if (!NostrSignerIntentStore.isNostrSignerIntent(intent)) return intent;
        if (!Nip46ConnectionStore.isEnabled(this)) {
            // Signer feature off — don't route a stray nostrsigner intent into
            // the signer approval flow; just open the app normally.
            return intent;
        }
        try {
            String requestId = NostrSignerIntentStore.savePending(this, intent);
            Uri appUri = Uri.parse("deepmarks://signer?androidRequest=" + Uri.encode(requestId));
            Intent forwarded = new Intent(Intent.ACTION_VIEW, appUri);
            forwarded.setPackage(getPackageName());
            return forwarded;
        } catch (Exception ignored) {
            setResult(RESULT_CANCELED);
            finish();
            return null;
        }
    }
}
