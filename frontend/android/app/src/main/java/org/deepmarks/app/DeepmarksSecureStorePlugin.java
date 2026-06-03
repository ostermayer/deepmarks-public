package org.deepmarks.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.Executor;

@CapacitorPlugin(name = "DeepmarksSecureStore")
public class DeepmarksSecureStorePlugin extends Plugin {
    private static final String METHOD_GET_PUBLIC_KEY = "get_public_key";
    private static final String METHOD_SIGN_EVENT = "sign_event";
    private static final String METHOD_NIP04_ENCRYPT = "nip04_encrypt";
    private static final String METHOD_NIP04_DECRYPT = "nip04_decrypt";
    private static final String METHOD_NIP44_ENCRYPT = "nip44_encrypt";
    private static final String METHOD_NIP44_DECRYPT = "nip44_decrypt";
    private static final String METHOD_DECRYPT_ZAP_EVENT = "decrypt_zap_event";

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
            android.app.Activity activity = getActivity();
            if (activity == null) {
                call.reject("Android signer result bridge is unavailable");
                return;
            }
            boolean completed = NostrSignerIntentStore.complete(
                activity,
                requestId,
                result,
                call.getString("id"),
                call.getString("event")
            );
            if (!completed) {
                call.reject("Android signer request is no longer pending");
                return;
            }
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
            android.app.Activity activity = getActivity();
            if (activity == null) {
                call.reject("Android signer result bridge is unavailable");
                return;
            }
            boolean rejected = NostrSignerIntentStore.reject(activity, requestId);
            if (!rejected) {
                call.reject("Android signer request is no longer pending");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void setNostrSignerTrust(PluginCall call) {
        String appId = call.getString("appId");
        String level = call.getString("level");
        if (appId == null || appId.isEmpty()) {
            call.reject("appId is required");
            return;
        }
        if (level == null || NostrSignerTrustStore.normalize(level).isEmpty()) {
            call.reject("valid trust level is required");
            return;
        }
        try {
            NostrSignerTrustStore.set(
                getContext(),
                appId,
                level,
                call.getString("requesterName", "")
            );
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void removeNostrSignerTrust(PluginCall call) {
        String appId = call.getString("appId");
        if (appId == null || appId.isEmpty()) {
            call.reject("appId is required");
            return;
        }
        try {
            NostrSignerTrustStore.remove(getContext(), appId);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void listNostrSignerTrust(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("permissions", NostrSignerTrustStore.list(getContext()));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void listAndroidSigners(PluginCall call) {
        try {
            JSArray signers = new JSArray();
            for (String packageName : externalSignerPackages()) {
                JSObject item = new JSObject();
                item.put("packageName", packageName);
                item.put("appName", NostrSignerProvider.labelForPackage(getContext(), packageName));
                signers.put(item);
            }
            JSObject ret = new JSObject();
            ret.put("signers", signers);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void connectAndroidSigner(PluginCall call) {
        Intent intent = signerIntent(
            METHOD_GET_PUBLIC_KEY,
            "",
            "",
            "",
            "",
            "",
            call.getString("permissions", "")
        );
        List<String> packages = externalSignerPackages();
        if (packages.isEmpty()) {
            call.reject("Install Amber, Primal, or another Android signer and try again");
            return;
        }
        String requestedPackage = call.getString("packageName", "");
        if (requestedPackage != null && !requestedPackage.isEmpty()) {
            if (!packages.contains(requestedPackage)) {
                call.reject("Selected Android signer is unavailable");
                return;
            }
            intent.setPackage(requestedPackage);
            startSignerActivity(call, intent, "connectAndroidSignerResult");
            return;
        }
        startSignerActivity(call, externalSignerChooser(intent, packages), "connectAndroidSignerResult");
    }

    @ActivityCallback
    private void connectAndroidSignerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject resolved = resolveSignerActivityResult(call, result, true);
        if (resolved != null) call.resolve(resolved);
    }

    @PluginMethod
    public void callAndroidSigner(PluginCall call) {
        String packageName = call.getString("packageName");
        String method = normalizeAndroidSignerMethod(call.getString("type"));
        String content = call.getString("content", "");
        String currentUser = call.getString("currentUser", "");
        String pubkey = call.getString("pubkey", "");
        if (packageName == null || packageName.isEmpty()) {
            call.reject("packageName is required");
            return;
        }
        if (method.isEmpty()) {
            call.reject("supported Android signer type is required");
            return;
        }
        try {
            JSObject providerResult = queryAndroidSignerProvider(
                packageName,
                method,
                content,
                pubkey,
                currentUser
            );
            if (providerResult != null) {
                providerResult.put("packageName", packageName);
                providerResult.put("appName", NostrSignerProvider.labelForPackage(getContext(), packageName));
                call.resolve(providerResult);
                return;
            }
        } catch (Exception ignored) {
            // Fall back to the foreground NIP-55 flow when a signer
            // does not expose, allow, or trust the content-provider path.
        }

        Intent intent = signerIntent(
            method,
            content,
            pubkey,
            currentUser,
            call.getString("id", ""),
            call.getString("returnType", ""),
            ""
        );
        intent.setPackage(packageName);
        startSignerActivity(call, intent, "androidSignerResult");
    }

    @ActivityCallback
    private void androidSignerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject resolved = resolveSignerActivityResult(call, result, false);
        if (resolved != null) call.resolve(resolved);
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

    private void startSignerActivity(PluginCall call, Intent intent, String callbackName) {
        try {
            startActivityForResult(call, intent, callbackName);
        } catch (ActivityNotFoundException e) {
            call.reject("No Android signer can handle this request");
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private JSObject resolveSignerActivityResult(
        PluginCall call,
        ActivityResult activityResult,
        boolean connecting
    ) {
        if (activityResult == null || activityResult.getResultCode() != Activity.RESULT_OK) {
            call.reject("Android signer request was rejected");
            return null;
        }
        Intent data = activityResult.getData();
        String result = firstExtra(data, "result", "signature", "pubkey");
        String event = firstExtra(data, "event");
        if ((result == null || result.isEmpty()) && event != null && !event.isEmpty()) result = event;
        if (result == null || result.isEmpty()) {
            call.reject("Android signer returned an empty response");
            return null;
        }

        String packageName = firstExtra(data, "package", "packageName", "signerPackage");
        if (packageName == null || packageName.isEmpty()) packageName = call.getString("packageName", "");
        if ((packageName == null || packageName.isEmpty()) && connecting) packageName = onlyExternalSignerPackage();
        JSObject ret = new JSObject();
        ret.put("result", result);
        ret.put("id", firstExtra(data, "id"));
        ret.put("event", event == null ? JSONObject.NULL : event);
        if (packageName != null && !packageName.isEmpty()) {
            ret.put("packageName", packageName);
            ret.put("appName", NostrSignerProvider.labelForPackage(getContext(), packageName));
        }
        if (connecting) {
            if (!isHexPubkey(result)) {
                call.reject("Android signer returned an invalid public key");
                return null;
            }
            if (packageName == null || packageName.isEmpty()) {
                call.reject("Android signer did not identify its package");
                return null;
            }
            if (packageName.equals(getContext().getPackageName())) {
                call.reject("Choose a separate Android signer such as Amber or Primal");
                return null;
            }
            ret.put("pubkey", result.toLowerCase());
        }
        return ret;
    }

    private Intent externalSignerChooser(Intent request, List<String> packages) {
        Intent primary = new Intent(request);
        primary.setPackage(packages.get(0));
        if (packages.size() == 1) return primary;

        Intent chooser = Intent.createChooser(primary, "Choose Android signer");
        Intent[] initial = new Intent[packages.size() - 1];
        for (int i = 1; i < packages.size(); i += 1) {
            Intent option = new Intent(request);
            option.setPackage(packages.get(i));
            initial[i - 1] = option;
        }
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, initial);
        return chooser;
    }

    private String onlyExternalSignerPackage() {
        List<String> packages = externalSignerPackages();
        return packages.size() == 1 ? packages.get(0) : "";
    }

    private List<String> externalSignerPackages() {
        ArrayList<String> out = new ArrayList<>();
        try {
            Intent probe = signerIntent(METHOD_GET_PUBLIC_KEY, "", "", "", "", "", "");
            List<ResolveInfo> matches = getContext().getPackageManager().queryIntentActivities(probe, 0);
            LinkedHashSet<String> unique = new LinkedHashSet<>();
            String own = getContext().getPackageName();
            for (ResolveInfo match : matches) {
                if (match == null || match.activityInfo == null) continue;
                String packageName = match.activityInfo.packageName;
                if (packageName == null || packageName.isEmpty() || packageName.equals(own)) continue;
                unique.add(packageName);
            }
            out.addAll(unique);
        } catch (Exception ignored) {
        }
        return out;
    }

    private JSObject queryAndroidSignerProvider(
        String packageName,
        String method,
        String content,
        String pubkey,
        String currentUser
    ) {
        String[] projection = projectionForSignerMethod(method, content, pubkey, currentUser);
        for (String authority : authoritiesFor(packageName, method)) {
            try (Cursor cursor = getContext().getContentResolver().query(
                Uri.parse("content://" + authority),
                projection,
                null,
                null,
                null
            )) {
                if (cursor == null || !cursor.moveToFirst()) continue;
                String result = cursorString(cursor, "result");
                if (result == null || result.isEmpty()) continue;
                JSObject ret = new JSObject();
                ret.put("result", result);
                String event = cursorString(cursor, "event");
                if (event != null && !event.isEmpty()) ret.put("event", event);
                return ret;
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private static Intent signerIntent(
        String method,
        String content,
        String pubkey,
        String currentUser,
        String id,
        String returnType,
        String permissions
    ) {
        Intent intent = new Intent(
            Intent.ACTION_VIEW,
            Uri.parse("nostrsigner:" + Uri.encode(content == null ? "" : content))
        );
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.putExtra("type", method);
        putExtraIfPresent(intent, "pubkey", pubkey);
        putExtraIfPresent(intent, "current_user", currentUser);
        putExtraIfPresent(intent, "id", id);
        putExtraIfPresent(intent, "returnType", returnType);
        putExtraIfPresent(intent, "permissions", permissions);
        return intent;
    }

    private static void putExtraIfPresent(Intent intent, String name, String value) {
        if (value != null && !value.isEmpty()) intent.putExtra(name, value);
    }

    private static String firstExtra(Intent data, String... names) {
        if (data == null) return "";
        for (String name : names) {
            String value = data.getStringExtra(name);
            if (value != null && !value.isEmpty()) return value;
        }
        return "";
    }

    private static String cursorString(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        if (index < 0 || cursor.isNull(index)) return "";
        return cursor.getString(index);
    }

    private static String[] projectionForSignerMethod(
        String method,
        String content,
        String pubkey,
        String currentUser
    ) {
        if (METHOD_GET_PUBLIC_KEY.equals(method)) {
            return new String[] { currentUser == null ? "" : currentUser };
        }
        if (
            METHOD_SIGN_EVENT.equals(method) ||
            METHOD_NIP04_ENCRYPT.equals(method) ||
            METHOD_NIP04_DECRYPT.equals(method) ||
            METHOD_NIP44_ENCRYPT.equals(method) ||
            METHOD_NIP44_DECRYPT.equals(method) ||
            METHOD_DECRYPT_ZAP_EVENT.equals(method)
        ) {
            return new String[] {
                content == null ? "" : content,
                pubkey == null ? "" : pubkey,
                currentUser == null ? "" : currentUser
            };
        }
        return new String[] { content == null ? "" : content };
    }

    private static String[] authoritiesFor(String packageName, String method) {
        String upper;
        switch (method) {
            case METHOD_GET_PUBLIC_KEY:
                upper = "GET_PUBLIC_KEY";
                break;
            case METHOD_SIGN_EVENT:
                upper = "SIGN_EVENT";
                break;
            case METHOD_NIP04_ENCRYPT:
                upper = "NIP04_ENCRYPT";
                break;
            case METHOD_NIP04_DECRYPT:
                upper = "NIP04_DECRYPT";
                break;
            case METHOD_NIP44_ENCRYPT:
                upper = "NIP44_ENCRYPT";
                break;
            case METHOD_NIP44_DECRYPT:
                upper = "NIP44_DECRYPT";
                break;
            case METHOD_DECRYPT_ZAP_EVENT:
                upper = "DECRYPT_ZAP_EVENT";
                break;
            default:
                upper = method.toUpperCase();
                break;
        }
        return new String[] { packageName + "." + upper, packageName + "." + method };
    }

    private static String normalizeAndroidSignerMethod(String raw) {
        if (raw == null) return "";
        switch (raw) {
            case METHOD_GET_PUBLIC_KEY:
            case METHOD_SIGN_EVENT:
            case METHOD_NIP04_ENCRYPT:
            case METHOD_NIP04_DECRYPT:
            case METHOD_NIP44_ENCRYPT:
            case METHOD_NIP44_DECRYPT:
            case METHOD_DECRYPT_ZAP_EVENT:
                return raw;
            default:
                return "";
        }
    }

    private static boolean isHexPubkey(String value) {
        return value != null && value.matches("(?i)^[0-9a-f]{64}$");
    }
}
