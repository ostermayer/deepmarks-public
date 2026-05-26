package org.deepmarks.app;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "DeepmarksNip46Service")
public class Nip46ServiceControllerPlugin extends Plugin {
    @PluginMethod
    public void setEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        try {
            Nip46ConnectionStore.setEnabled(getContext(), enabled);
            if (enabled) {
                startService(Nip46ForegroundService.ACTION_START);
            } else {
                startService(Nip46ForegroundService.ACTION_STOP);
            }
            call.resolve(statusObject());
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void refresh(PluginCall call) {
        try {
            if (Nip46ConnectionStore.isEnabled(getContext())) {
                startService(Nip46ForegroundService.ACTION_REFRESH);
            }
            call.resolve(statusObject());
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    private void startService(String action) {
        Intent intent = new Intent(getContext(), Nip46ForegroundService.class);
        intent.setAction(action);
        if (Nip46ForegroundService.ACTION_STOP.equals(action)) {
            getContext().startService(intent);
        } else {
            ContextCompat.startForegroundService(getContext(), intent);
        }
    }

    private JSObject statusObject() {
        Nip46ForegroundService.Status status = Nip46ForegroundService.status(getContext());
        JSObject ret = new JSObject();
        ret.put("enabled", status.enabled);
        ret.put("running", status.running);
        ret.put("accountPubkey", status.accountPubkey == null ? JSONObject.NULL : status.accountPubkey);
        ret.put("connectionCount", status.connectionCount);
        ret.put("relayCount", status.relayCount);
        ret.put("lastMessage", status.lastMessage);
        ret.put("lastError", status.lastError);
        return ret;
    }
}
