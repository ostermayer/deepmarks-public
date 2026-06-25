package org.deepmarks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import okhttp3.OkHttpClient;

public class Nip46ForegroundService extends Service {
    static final String ACTION_START = "org.deepmarks.app.nip46.START";
    static final String ACTION_REFRESH = "org.deepmarks.app.nip46.REFRESH";
    static final String ACTION_RESOLVE = "org.deepmarks.app.nip46.RESOLVE";
    static final String ACTION_STOP = "org.deepmarks.app.nip46.STOP";
    static final String EXTRA_REQUEST_ID = "requestId";
    static final String EXTRA_APPROVED = "approved";
    static final String EXTRA_TRUST_LEVEL = "trustLevel";

    private static final String CHANNEL_ID = "deepmarks_nip46_signer";
    private static final int NOTIFICATION_ID = 39701;
    private static final long EVENT_SINCE_SKEW_SECONDS = 120L;
    private static final int SEEN_EVENT_LIMIT = 1_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Nip46RelayClient> relayClients = new ArrayList<>();
    private final Set<String> openRelays = new HashSet<>();
    private final Set<String> seenEventIds = new HashSet<>();
    private final ArrayDeque<String> seenEventOrder = new ArrayDeque<>();

    private OkHttpClient httpClient;
    private NostrNip46RequestHandler.Account account;
    private List<NostrNip46RequestHandler.Connection> connections = new ArrayList<>();
    private long serviceStartedAt;

    private static volatile Status currentStatus = Status.stopped(false, null, 0, 0, "not started", "");

    @Override
    public void onCreate() {
        super.onCreate();
        httpClient = new OkHttpClient.Builder().build();
        serviceStartedAt = System.currentTimeMillis() / 1000L;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopFromUser();
            return START_NOT_STICKY;
        }

        if (!Nip46ConnectionStore.isEnabled(this)) {
            closeRelays();
            currentStatus = Status.stopped(false, null, 0, 0, "stopped", "");
            stopSelf();
            return START_NOT_STICKY;
        }

        startInForeground("Starting Deepmarks signer");
        if (ACTION_RESOLVE.equals(action)) {
            if (account == null || connections.isEmpty()) refreshFromStore();
            resolvePendingApproval(intent);
            return START_STICKY;
        }
        refreshFromStore();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        closeRelays();
        if (httpClient != null) {
            httpClient.dispatcher().executorService().shutdown();
            httpClient.connectionPool().evictAll();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static Status status(Context context) {
        Status status = currentStatus;
        boolean enabled = Nip46ConnectionStore.isEnabled(context);
        if (status.running || status.accountPubkey != null || !enabled) {
            return status.withEnabled(enabled);
        }
        try {
            NostrNip46RequestHandler.Account account = Nip46ConnectionStore.loadAccount(context);
            List<NostrNip46RequestHandler.Connection> connections = Nip46ConnectionStore.loadConnections(context);
            return Status.stopped(
                enabled,
                account == null ? null : account.pubkey,
                connections.size(),
                Nip46ConnectionStore.relayUnion(connections).size(),
                enabled ? "ready to start" : "stopped",
                ""
            );
        } catch (Exception e) {
            return Status.stopped(enabled, null, 0, 0, "stopped", e.getMessage());
        }
    }

    private void refreshFromStore() {
        try {
            account = Nip46ConnectionStore.loadAccount(this);
            connections = Nip46ConnectionStore.loadConnections(this);
            List<String> relays = Nip46ConnectionStore.relayUnion(connections);
            if (account == null || connections.isEmpty() || relays.isEmpty()) {
                closeRelays();
                currentStatus = Status.stopped(
                    true,
                    account == null ? null : account.pubkey,
                    connections.size(),
                    relays.size(),
                    account == null ? "add a mobile signer key" : "pair a client",
                    ""
                );
                updateNotification();
                stopForegroundCompat();
                stopSelf();
                return;
            }

            closeRelays();
            seenEventIds.clear();
            seenEventOrder.clear();
            long since = Math.max(0, serviceStartedAt - EVENT_SINCE_SKEW_SECONDS);
            for (String relay : relays) {
                Nip46RelayClient client = new Nip46RelayClient(
                    relay,
                    account.pubkey,
                    since,
                    httpClient,
                    handler,
                    relayCallback
                );
                relayClients.add(client);
                client.connect();
            }
            currentStatus = new Status(
                true,
                true,
                account.pubkey,
                connections.size(),
                relays.size(),
                "listening on " + relays.size() + " relay" + (relays.size() == 1 ? "" : "s"),
                ""
            );
            updateNotification();
        } catch (Exception e) {
            closeRelays();
            currentStatus = Status.stopped(true, null, 0, 0, "stopped", e.getMessage());
            updateNotification();
            stopForegroundCompat();
            stopSelf();
        }
    }

    private void handleRelayEvent(String relayUrl, String eventJson) {
        try {
            NostrNip46RequestHandler.IncomingEvent event = NostrNip46RequestHandler.IncomingEvent.parse(eventJson);
            if (!rememberEvent(event.id)) return;
            if (account == null) return;
            NostrNip46RequestHandler.Connection connection = Nip46ConnectionStore.findConnection(connections, event.pubkey);
            if (connection == null) return;
            NostrNip46RequestHandler.Request request =
                NostrNip46RequestHandler.verifiedRequest(account, connection, eventJson);
            if (request == null) return;
            List<String> requestedPerms = NostrNip46RequestHandler.connectRequestedPermissions(account, connection, eventJson);
            if (shouldAskUser(connection, request, requestedPerms)) {
                String requestId = Nip46ForegroundApprovalStore.savePending(
                    this,
                    account,
                    connection,
                    request,
                    eventJson,
                    requestedPerms
                );
                openApprovalScreen(requestId);
                currentStatus = currentStatus.withMessage("approval needed for " + shortKey(connection.clientPubkey), "");
                updateNotification();
                return;
            }
            if (
                request.method.equals("connect") &&
                !requestedPerms.isEmpty() &&
                !connection.trustLevel.equals(NostrNip46RequestHandler.Connection.TRUST_LOW)
            ) {
                connection = Nip46ConnectionStore.updateConnectionApproval(
                    this,
                    connection.clientPubkey,
                    requestedPerms,
                    connection.trustLevel
                );
                connections = Nip46ConnectionStore.loadConnections(this);
            }
            NostrEventSigner.SignedEvent response = NostrNip46RequestHandler.handle(account, connection, eventJson);
            if (response == null) return;
            publishResponse(connection, response.toJson());
            Nip46ConnectionStore.touchConnection(this, connection.clientPubkey, System.currentTimeMillis() / 1000L);
            currentStatus = currentStatus.withMessage("signed request from " + shortKey(connection.clientPubkey), "");
            updateNotification();
        } catch (Exception e) {
            currentStatus = currentStatus.withMessage(currentStatus.lastMessage, e.getMessage());
            updateNotification();
        }
    }

    private boolean shouldAskUser(
        NostrNip46RequestHandler.Connection connection,
        NostrNip46RequestHandler.Request request,
        List<String> requestedPerms
    ) {
        if (connection.trustLevel.equals(NostrNip46RequestHandler.Connection.TRUST_UNSET)) return true;
        if (connection.trustLevel.equals(NostrNip46RequestHandler.Connection.TRUST_FULL)) return false;
        if (connection.trustLevel.equals(NostrNip46RequestHandler.Connection.TRUST_LOW)) {
            return !isSafeMethod(request.method);
        }
        if (request.method.equals("connect")) return false;
        String permission = NostrNip46RequestHandler.permissionForRequest(request);
        return !connection.perms.contains(permission) && !connection.perms.contains(request.method);
    }

    private boolean isSafeMethod(String method) {
        return method.equals("connect") ||
            method.equals("get_public_key") ||
            method.equals("ping") ||
            method.equals("switch_relays");
    }

    private void resolvePendingApproval(Intent intent) {
        String requestId = intent == null ? "" : intent.getStringExtra(EXTRA_REQUEST_ID);
        boolean approved = intent != null && intent.getBooleanExtra(EXTRA_APPROVED, false);
        String trustLevel = intent == null ? NostrNip46RequestHandler.Connection.TRUST_LOW : intent.getStringExtra(EXTRA_TRUST_LEVEL);
        try {
            org.json.JSONObject pending = Nip46ForegroundApprovalStore.getPending(this);
            if (pending == null || !requestId.equals(pending.optString("requestId"))) return;
            String eventJson = Nip46ForegroundApprovalStore.requestEvent(pending);
            if (account == null) account = Nip46ConnectionStore.loadAccount(this);
            connections = Nip46ConnectionStore.loadConnections(this);
            if (account == null) return;
            NostrNip46RequestHandler.Connection connection =
                Nip46ConnectionStore.findConnection(connections, pending.optString("clientPubkey"));
            if (connection == null) return;

            NostrEventSigner.SignedEvent response;
            if (!approved) {
                response = NostrNip46RequestHandler.errorResponse(
                    account,
                    connection,
                    eventJson,
                    "request rejected",
                    System.currentTimeMillis() / 1000L
                );
            } else {
                NostrNip46RequestHandler.Request request =
                    NostrNip46RequestHandler.verifiedRequest(account, connection, eventJson);
                List<String> permsToAdd = approvalPerms(request, pending, trustLevel);
                connection = Nip46ConnectionStore.updateConnectionApproval(
                    this,
                    connection.clientPubkey,
                    permsToAdd,
                    trustLevel
                );
                connections = Nip46ConnectionStore.loadConnections(this);
                response = NostrNip46RequestHandler.approvedResponse(
                    account,
                    connection,
                    eventJson,
                    System.currentTimeMillis() / 1000L
                );
            }
            if (response != null) publishResponse(connection, response.toJson());
            Nip46ForegroundApprovalStore.clear(this, requestId);
            currentStatus = currentStatus.withMessage(
                approved ? "approved request from " + shortKey(connection.clientPubkey) : "rejected request from " + shortKey(connection.clientPubkey),
                ""
            );
            updateNotification();
        } catch (Exception e) {
            currentStatus = currentStatus.withMessage(currentStatus.lastMessage, e.getMessage());
            updateNotification();
        }
    }

    private List<String> approvalPerms(
        NostrNip46RequestHandler.Request request,
        org.json.JSONObject pending,
        String trustLevel
    ) {
        List<String> out = new ArrayList<>();
        String normalizedTrust = NostrNip46RequestHandler.Connection.normalizeTrust(trustLevel);
        if (request == null) return out;
        if (normalizedTrust.equals(NostrNip46RequestHandler.Connection.TRUST_LOW)) return out;
        if (request.method.equals("connect")) {
            org.json.JSONArray permissions = pending.optJSONArray("permissions");
            if (permissions != null) {
                for (int i = 0; i < permissions.length(); i++) {
                    String permission = permissions.optString(i, "").trim();
                    if (!permission.isEmpty()) out.add(permission);
                }
            }
        } else {
            out.add(NostrNip46RequestHandler.permissionForRequest(request));
        }
        return out;
    }

    private void openApprovalScreen(String requestId) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setAction(Intent.ACTION_VIEW);
        openIntent.setData(android.net.Uri.parse("deepmarks://mobile-signer?foregroundRequest=" + android.net.Uri.encode(requestId)));
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            startActivity(openIntent);
        } catch (Exception ignored) {
        }
    }

    private void publishResponse(NostrNip46RequestHandler.Connection connection, String eventJson) {
        for (Nip46RelayClient client : relayClients) {
            client.publish(eventJson);
        }
    }

    private void closeRelays() {
        for (Nip46RelayClient client : relayClients) client.close();
        relayClients.clear();
        openRelays.clear();
    }

    private boolean rememberEvent(String eventId) {
        if (seenEventIds.contains(eventId)) return false;
        seenEventIds.add(eventId);
        seenEventOrder.addLast(eventId);
        while (seenEventOrder.size() > SEEN_EVENT_LIMIT) {
            String old = seenEventOrder.removeFirst();
            seenEventIds.remove(old);
        }
        return true;
    }

    private void stopFromUser() {
        try {
            Nip46ConnectionStore.setEnabled(this, false);
        } catch (Exception ignored) {
        }
        closeRelays();
        currentStatus = Status.stopped(false, account == null ? null : account.pubkey, connections.size(), 0, "stopped", "");
        stopForegroundCompat();
        stopSelf();
    }

    private void startInForeground(String message) {
        ensureNotificationChannel();
        Notification notification = buildNotification(message);
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void updateNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(currentStatus.notificationText()));
    }

    private Notification buildNotification(String text) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setAction(Intent.ACTION_VIEW);
        openIntent.setData(android.net.Uri.parse("deepmarks://mobile-signer"));
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, Nip46ForegroundService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_flag)
            .setContentTitle("Deepmarks signer running")
            .setContentText(text)
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Stop", stopPendingIntent)
            .build();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel existing = manager.getNotificationChannel(CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Deepmarks signer",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows when the Deepmarks mobile signer is listening for NIP-46 requests.");
        manager.createNotificationChannel(channel);
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private final Nip46RelayClient.Callback relayCallback = new Nip46RelayClient.Callback() {
        @Override
        public void onOpen(String relayUrl) {
            openRelays.add(relayUrl);
            currentStatus = currentStatus.withMessage("connected to " + openRelays.size() + "/" + currentStatus.relayCount + " relays", "");
            updateNotification();
        }

        @Override
        public void onClosed(String relayUrl) {
            openRelays.remove(relayUrl);
            currentStatus = currentStatus.withMessage("connected to " + openRelays.size() + "/" + currentStatus.relayCount + " relays", currentStatus.lastError);
            updateNotification();
        }

        @Override
        public void onEvent(String relayUrl, String eventJson) {
            handleRelayEvent(relayUrl, eventJson);
        }

        @Override
        public void onError(String relayUrl, String message) {
            currentStatus = currentStatus.withMessage(currentStatus.lastMessage, relayUrl + ": " + message);
            updateNotification();
        }
    };

    private static String shortKey(String pubkey) {
        return pubkey.length() <= 12 ? pubkey : pubkey.substring(0, 8) + "…" + pubkey.substring(pubkey.length() - 4);
    }

    static final class Status {
        final boolean enabled;
        final boolean running;
        final String accountPubkey;
        final int connectionCount;
        final int relayCount;
        final String lastMessage;
        final String lastError;

        Status(
            boolean enabled,
            boolean running,
            String accountPubkey,
            int connectionCount,
            int relayCount,
            String lastMessage,
            String lastError
        ) {
            this.enabled = enabled;
            this.running = running;
            this.accountPubkey = accountPubkey;
            this.connectionCount = connectionCount;
            this.relayCount = relayCount;
            this.lastMessage = lastMessage == null ? "" : lastMessage;
            this.lastError = lastError == null ? "" : lastError;
        }

        static Status stopped(
            boolean enabled,
            String accountPubkey,
            int connectionCount,
            int relayCount,
            String lastMessage,
            String lastError
        ) {
            return new Status(enabled, false, accountPubkey, connectionCount, relayCount, lastMessage, lastError);
        }

        Status withEnabled(boolean enabled) {
            return new Status(enabled, running, accountPubkey, connectionCount, relayCount, lastMessage, lastError);
        }

        Status withMessage(String message, String error) {
            return new Status(enabled, running, accountPubkey, connectionCount, relayCount, message, error);
        }

        String notificationText() {
            if (!lastError.isEmpty()) return "Signer needs attention";
            if (!lastMessage.isEmpty()) return lastMessage;
            return running ? "Listening for paired NIP-46 requests" : "Signer stopped";
        }
    }
}
