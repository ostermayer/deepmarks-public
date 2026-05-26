package org.deepmarks.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

/**
 * Dedicated NIP-55 Android signer host. It owns the Android activity
 * result while rendering the normal Capacitor approval UI.
 */
public class NostrSignerActivity extends BridgeActivity {
    private String signerStartPath;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeepmarksSecureStorePlugin.class);
        registerPlugin(Nip46ServiceControllerPlugin.class);
        Intent routed = signerRouteIntent(getIntent());
        if (routed != null) setIntent(routed);
        if (signerStartPath != null) {
            config = new CapConfig.Builder(this)
                .setStartPath(signerStartPath)
                .create();
        }
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        Intent routed = signerRouteIntent(intent);
        if (routed == null) return;
        super.onNewIntent(routed);
        setIntent(routed);
        openSignerRoute();
    }

    private Intent signerRouteIntent(Intent intent) {
        if (!NostrSignerIntentStore.isNostrSignerIntent(intent)) {
            return intent;
        }
        try {
            String requestId = NostrSignerIntentStore.savePending(this, intent);
            signerStartPath = "/app/mobile-signer/android?request=" + Uri.encode(requestId);
            Uri appUri = Uri.parse("deepmarks://signer?androidRequest=" + Uri.encode(requestId));
            Intent routed = new Intent(Intent.ACTION_VIEW, appUri);
            routed.setPackage(getPackageName());
            return routed;
        } catch (Exception ignored) {
            setResult(RESULT_CANCELED);
            finish();
            return null;
        }
    }

    private void openSignerRoute() {
        if (bridge == null || signerStartPath == null) return;
        bridge.getWebView().post(() -> bridge.getWebView().loadUrl(bridge.getLocalUrl() + signerStartPath));
    }
}
