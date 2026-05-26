package org.deepmarks.app;

import android.os.Handler;

import java.util.List;
import java.util.Map;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

final class Nip46RelayClient {
    interface Callback {
        void onOpen(String relayUrl);
        void onClosed(String relayUrl);
        void onEvent(String relayUrl, String eventJson);
        void onError(String relayUrl, String message);
    }

    private final String relayUrl;
    private final String signerPubkey;
    private final long since;
    private final OkHttpClient httpClient;
    private final Handler handler;
    private final Callback callback;
    private final String subscriptionId;

    private WebSocket socket;
    private boolean stopped;
    private int reconnectAttempt;

    Nip46RelayClient(
        String relayUrl,
        String signerPubkey,
        long since,
        OkHttpClient httpClient,
        Handler handler,
        Callback callback
    ) {
        this.relayUrl = relayUrl;
        this.signerPubkey = signerPubkey;
        this.since = since;
        this.httpClient = httpClient;
        this.handler = handler;
        this.callback = callback;
        this.subscriptionId = "deepmarks-mobile-signer-" + Integer.toHexString(relayUrl.hashCode());
    }

    void connect() {
        stopped = false;
        Request request = new Request.Builder().url(relayUrl).build();
        socket = httpClient.newWebSocket(request, new Listener());
    }

    void close() {
        stopped = true;
        handler.removeCallbacksAndMessages(this);
        WebSocket current = socket;
        socket = null;
        if (current != null) {
            current.close(1000, "stopped");
        }
    }

    void publish(String eventJson) {
        WebSocket current = socket;
        if (current != null) {
            current.send("[\"EVENT\"," + eventJson + "]");
        }
    }

    private void subscribe() {
        String filter = "{\"kinds\":[" + NostrNip46RequestHandler.KIND + "],\"#p\":[" +
            NostrJson.quote(signerPubkey) + "],\"since\":" + since + "}";
        WebSocket current = socket;
        if (current != null) {
            current.send("[\"REQ\"," + NostrJson.quote(subscriptionId) + "," + filter + "]");
        }
    }

    private void scheduleReconnect() {
        if (stopped) return;
        int delaySeconds = Math.min(30, 2 << Math.min(reconnectAttempt, 4));
        reconnectAttempt++;
        handler.postAtTime(this::connect, this, android.os.SystemClock.uptimeMillis() + delaySeconds * 1000L);
    }

    private void postCallback(Runnable runnable) {
        handler.postAtTime(() -> {
            if (!stopped) runnable.run();
        }, this, android.os.SystemClock.uptimeMillis());
    }

    private final class Listener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            socket = webSocket;
            reconnectAttempt = 0;
            postCallback(() -> callback.onOpen(relayUrl));
            subscribe();
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            try {
                Object parsed = NostrJson.parse(text);
                if (!(parsed instanceof List)) return;
                List<?> row = (List<?>) parsed;
                if (row.size() < 3 || !"EVENT".equals(row.get(0))) return;
                if (!subscriptionId.equals(row.get(1))) return;
                Object event = row.get(2);
                if (!(event instanceof Map)) return;
                String eventJson = NostrJson.stringify(event);
                postCallback(() -> callback.onEvent(relayUrl, eventJson));
            } catch (Exception e) {
                postCallback(() -> callback.onError(relayUrl, e.getMessage()));
            }
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            webSocket.close(code, reason);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (socket == webSocket) socket = null;
            if (stopped) return;
            postCallback(() -> callback.onClosed(relayUrl));
            scheduleReconnect();
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            if (socket == webSocket) socket = null;
            if (stopped) return;
            String message = t.getMessage() == null ? "relay connection failed" : t.getMessage();
            postCallback(() -> {
                callback.onError(relayUrl, message);
                callback.onClosed(relayUrl);
            });
            scheduleReconnect();
        }
    }
}
