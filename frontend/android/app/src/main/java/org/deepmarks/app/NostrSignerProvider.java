package org.deepmarks.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Binder;

import java.util.Locale;

public class NostrSignerProvider extends ContentProvider {
    private static final String METHOD_GET_PUBLIC_KEY = "get_public_key";
    private static final String METHOD_SIGN_EVENT = "sign_event";
    private static final String METHOD_NIP04_ENCRYPT = "nip04_encrypt";
    private static final String METHOD_NIP04_DECRYPT = "nip04_decrypt";
    private static final String METHOD_NIP44_ENCRYPT = "nip44_encrypt";
    private static final String METHOD_NIP44_DECRYPT = "nip44_decrypt";
    private static final String METHOD_DECRYPT_ZAP_EVENT = "decrypt_zap_event";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(
        Uri uri,
        String[] projection,
        String selection,
        String[] selectionArgs,
        String sortOrder
    ) {
        Context context = getContext();
        if (context == null) return empty(new String[] { "result" });
        String method = methodFromAuthority(context, uri == null ? "" : uri.getAuthority());
        String[] columns = columnsFor(method);
        if (method.isEmpty()) return empty(columns);
        String caller = callingPackage(context);
        if (caller.isEmpty()) return empty(columns);
        if (!NostrSignerTrustStore.allowsBackground(
            context,
            caller,
            method,
            method.equals(METHOD_SIGN_EVENT) && projection != null && projection.length > 0 ? projection[0] : ""
        )) {
            return empty(columns);
        }

        try {
            NostrNip46RequestHandler.Account account = Nip46ConnectionStore.loadAccount(context);
            if (account == null) return empty(columns);
            String currentUser = NostrSignerActions.currentUser(projection);
            if (!NostrSignerActions.currentUserMatches(account, currentUser)) return empty(columns);

            MatrixCursor cursor = new MatrixCursor(columns);
            switch (method) {
                case METHOD_GET_PUBLIC_KEY:
                    cursor.addRow(new Object[] { account.pubkey });
                    return cursor;
                case METHOD_SIGN_EVENT:
                    if (projection == null || projection.length < 1) return empty(columns);
                    NostrEventSigner.SignedEvent signed = NostrSignerActions.signEvent(account, projection[0]);
                    cursor.addRow(new Object[] { signed.sig, signed.toJson() });
                    return cursor;
                case METHOD_NIP04_ENCRYPT:
                    if (projection == null || projection.length < 2) return empty(columns);
                    cursor.addRow(new Object[] { NostrSignerActions.nip04Encrypt(account, projection[0], projection[1]) });
                    return cursor;
                case METHOD_NIP04_DECRYPT:
                    if (projection == null || projection.length < 2) return empty(columns);
                    cursor.addRow(new Object[] { NostrSignerActions.nip04Decrypt(account, projection[0], projection[1]) });
                    return cursor;
                case METHOD_NIP44_ENCRYPT:
                    if (projection == null || projection.length < 2) return empty(columns);
                    cursor.addRow(new Object[] { NostrSignerActions.nip44Encrypt(account, projection[0], projection[1]) });
                    return cursor;
                case METHOD_NIP44_DECRYPT:
                    if (projection == null || projection.length < 2) return empty(columns);
                    cursor.addRow(new Object[] { NostrSignerActions.nip44Decrypt(account, projection[0], projection[1]) });
                    return cursor;
                case METHOD_DECRYPT_ZAP_EVENT:
                    if (projection == null || projection.length < 1) return empty(columns);
                    cursor.addRow(new Object[] { NostrSignerActions.decryptZapEvent(account, projection[0]) });
                    return cursor;
                default:
                    return empty(columns);
            }
        } catch (Exception ignored) {
            return empty(columns);
        }
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    private static MatrixCursor empty(String[] columns) {
        return new MatrixCursor(columns);
    }

    private static String[] columnsFor(String method) {
        if (METHOD_SIGN_EVENT.equals(method)) return new String[] { "result", "event" };
        return new String[] { "result" };
    }

    private static String methodFromAuthority(Context context, String authority) {
        if (authority == null || authority.isEmpty()) return "";
        String app = context.getPackageName();
        String suffix = authority.startsWith(app + ".")
            ? authority.substring(app.length() + 1)
            : authority;
        switch (suffix) {
            case "GET_PUBLIC_KEY":
            case "get_public_key":
                return METHOD_GET_PUBLIC_KEY;
            case "SIGN_EVENT":
            case "sign_event":
                return METHOD_SIGN_EVENT;
            case "NIP04_ENCRYPT":
            case "nip04_encrypt":
                return METHOD_NIP04_ENCRYPT;
            case "NIP04_DECRYPT":
            case "nip04_decrypt":
                return METHOD_NIP04_DECRYPT;
            case "NIP44_ENCRYPT":
            case "nip44_encrypt":
                return METHOD_NIP44_ENCRYPT;
            case "NIP44_DECRYPT":
            case "nip44_decrypt":
                return METHOD_NIP44_DECRYPT;
            case "DECRYPT_ZAP_EVENT":
            case "decrypt_zap_event":
                return METHOD_DECRYPT_ZAP_EVENT;
            default:
                return "";
        }
    }

    private String callingPackage(Context context) {
        String caller = getCallingPackage();
        if (caller != null && !caller.isEmpty() && !caller.equals(context.getPackageName())) {
            return caller;
        }
        try {
            String[] packages = context.getPackageManager().getPackagesForUid(Binder.getCallingUid());
            if (packages == null) return "";
            for (String item : packages) {
                if (item != null && !item.equals(context.getPackageName())) return item;
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    static String labelForPackage(Context context, String packageName) {
        if (packageName == null || packageName.isEmpty()) return "";
        try {
            PackageManager pm = context.getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            CharSequence label = pm.getApplicationLabel(info);
            return label == null ? packageName : label.toString();
        } catch (Exception ignored) {
            return packageName.toLowerCase(Locale.ROOT);
        }
    }
}
