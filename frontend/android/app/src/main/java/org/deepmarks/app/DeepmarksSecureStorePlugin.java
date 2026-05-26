package org.deepmarks.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import org.json.JSONObject;

import java.util.concurrent.Executor;

@CapacitorPlugin(name = "DeepmarksSecureStore")
public class DeepmarksSecureStorePlugin extends Plugin {
    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        try {
            String value = NativeSecureValueStore.get(getContext(), key);
            JSObject ret = new JSObject();
            ret.put("value", value == null ? JSONObject.NULL : value);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        if (value == null) {
            call.reject("value is required");
            return;
        }
        try {
            NativeSecureValueStore.set(getContext(), key, value);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        NativeSecureValueStore.remove(getContext(), key);
        call.resolve();
    }

    @PluginMethod
    public void canAuthenticateBiometric(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        );
        JSObject ret = new JSObject();
        ret.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("biometryType", "biometrics");
        ret.put("code", result);
        call.resolve(ret);
    }

    @PluginMethod
    public void authenticateBiometric(PluginCall call) {
        if (!(getActivity() instanceof FragmentActivity)) {
            call.reject("biometric unlock is unavailable");
            return;
        }
        int result = BiometricManager.from(getContext()).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        );
        if (result != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject("biometric unlock is unavailable");
            return;
        }

        String reason = call.getString("reason", "Unlock Deepmarks");
        Executor executor = ContextCompat.getMainExecutor(getContext());
        BiometricPrompt prompt = new BiometricPrompt(
            (FragmentActivity) getActivity(),
            executor,
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    JSObject ret = new JSObject();
                    ret.put("authenticated", true);
                    call.resolve(ret);
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    call.reject(errString == null ? "biometric unlock failed" : errString.toString());
                }

                @Override
                public void onAuthenticationFailed() {
                    // BiometricPrompt remains active after a non-matching scan.
                    // Only resolve/reject on final success, cancellation, or system error.
                }
            }
        );
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Deepmarks")
            .setSubtitle(reason)
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build();
        prompt.authenticate(promptInfo);
    }

    @PluginMethod
    public void getPendingNostrSignerRequest(PluginCall call) {
        try {
            JSONObject pending = NostrSignerIntentStore.getPending(getContext());
            if (pending == null) {
                call.resolve(null);
                return;
            }
            call.resolve(JSObject.fromJSONObject(pending));
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void completeNostrSignerRequest(PluginCall call) {
        String requestId = call.getString("requestId");
        String result = call.getString("result");
        if (requestId == null || requestId.isEmpty()) {
            call.reject("requestId is required");
            return;
        }
        if (result == null) {
            call.reject("result is required");
            return;
        }
        try {
            NostrSignerIntentStore.complete(
                getActivity(),
                requestId,
                result,
                call.getString("id"),
                call.getString("event")
            );
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void rejectNostrSignerRequest(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId == null || requestId.isEmpty()) {
            call.reject("requestId is required");
            return;
        }
        try {
            NostrSignerIntentStore.reject(getActivity(), requestId);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void getPendingSharedBookmark(PluginCall call) {
        try {
            JSONObject pending = PendingShareStore.get(getContext(), call.getString("id"));
            JSObject ret = new JSObject();
            ret.put("bookmark", pending == null ? JSONObject.NULL : pending);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void removePendingSharedBookmark(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("id is required");
            return;
        }
        try {
            PendingShareStore.remove(getContext(), id);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void writeShareDefaults(PluginCall call) {
        String defaultVisibility = call.getString("defaultVisibility", "private");
        boolean defaultReadLater = Boolean.TRUE.equals(call.getBoolean("defaultReadLater", false));
        JSArray defaultTags = call.getArray("defaultTags");
        if (defaultTags == null) defaultTags = new JSArray();
        PendingShareStore.writeDefaults(
            getContext(),
            defaultVisibility,
            defaultReadLater,
            defaultTags,
            call.getString("activePubkey", "")
        );
        call.resolve();
    }

    @PluginMethod
    public void writeUserTags(PluginCall call) {
        JSArray tags = call.getArray("tags");
        if (tags == null) tags = new JSArray();
        PendingShareStore.writeUserTags(getContext(), tags);
        call.resolve();
    }
}
