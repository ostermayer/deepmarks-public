package org.deepmarks.app;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

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

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "DeepmarksSecureStore")
public class DeepmarksSecureStorePlugin extends Plugin {
    private static final String PREFS = "deepmarks_secure_store";
    private static final String KEY_ALIAS = "deepmarks_secure_store_aes";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        try {
            String stored = prefs().getString(key, null);
            JSObject ret = new JSObject();
            ret.put("value", stored == null ? JSONObject.NULL : decrypt(stored));
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
            prefs().edit().putString(key, encrypt(value)).apply();
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
        prefs().edit().remove(key).apply();
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

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return encode(cipher.getIV()) + ":" + encode(ciphertext);
    }

    private String decrypt(String stored) throws Exception {
        String[] parts = stored.split(":", 2);
        if (parts.length != 2) throw new IllegalStateException("stored value is corrupt");
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            new GCMParameterSpec(GCM_TAG_BITS, decode(parts[0]))
        );
        return new String(cipher.doFinal(decode(parts[1])), StandardCharsets.UTF_8);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
            generator.init(
                new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            );
            generator.generateKey();
        }
        return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
    }

    private static String encode(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private static byte[] decode(String value) {
        return Base64.decode(value, Base64.NO_WRAP);
    }
}
