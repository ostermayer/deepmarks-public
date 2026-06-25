// Web Push subscribe / unsubscribe helpers. UI lives in
// /app/settings; this module owns the actual subscription dance.
//
// Flow:
//   1. Ask the browser for permission (must be triggered by user
//      gesture).
//   2. Fetch /web-push/public-key to learn the server VAPID public
//      key.
//   3. Call pushManager.subscribe(...).
//   4. POST the resulting subscription to /web-push/subscribe with
//      NIP-98 auth, so the server can look it up by pubkey when a
//      zap receipt arrives.

import { browser } from '$app/environment';
import { config } from '$lib/config';
import { buildNip98AuthHeader } from '$lib/api/client';

export type PushSupportStatus =
  | 'unsupported'           // browser lacks the APIs
  | 'denied'                // user clicked "Block" on the permission prompt
  | 'no-vapid'              // server doesn't expose a VAPID key (deploy gap)
  | 'subscribed'            // we have an active subscription
  | 'not-subscribed';       // capable + permitted but no subscription yet

export interface PushStatus {
  status: PushSupportStatus;
  endpoint?: string;
}

export async function detectPushStatus(): Promise<PushStatus> {
  if (!browser) return { status: 'unsupported' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { status: 'unsupported' };
  }
  if (Notification.permission === 'denied') return { status: 'denied' };
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) return { status: 'unsupported' };
  const existing = await reg.pushManager.getSubscription();
  if (existing) return { status: 'subscribed', endpoint: existing.endpoint };
  // Probe the VAPID key — if the server doesn't have one we can't
  // even ask for a permission prompt.
  const key = await fetchVapidPublicKey();
  if (!key) return { status: 'no-vapid' };
  return { status: 'not-subscribed' };
}

export async function subscribeToPush(): Promise<PushStatus> {
  if (!browser) return { status: 'unsupported' };
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { status: 'denied' };
  } else if (Notification.permission === 'denied') {
    return { status: 'denied' };
  }
  const reg = await navigator.serviceWorker.ready;
  const vapidPublicKey = await fetchVapidPublicKey();
  if (!vapidPublicKey) return { status: 'no-vapid' };
  // Replace any existing subscription so we don't end up with two
  // entries on the server for the same browser.
  const existing = await reg.pushManager.getSubscription();
  if (existing) await existing.unsubscribe().catch(() => undefined);
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as unknown as ArrayBuffer,
  });
  await postSubscription(subscription);
  return { status: 'subscribed', endpoint: subscription.endpoint };
}

export async function unsubscribeFromPush(): Promise<PushStatus> {
  if (!browser) return { status: 'unsupported' };
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return { status: 'not-subscribed' };
  const endpoint = subscription.endpoint;
  // Tell the server first so we drop the stored entry. Then
  // unsubscribe locally so the browser stops accepting pushes.
  await postUnsubscribe(endpoint).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
  return { status: 'not-subscribed' };
}

async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch(`${config.apiBase.replace(/\/$/, '')}/web-push/public-key`);
    if (!res.ok) return null;
    const body = (await res.json()) as { publicKey?: string };
    return body.publicKey ?? null;
  } catch {
    return null;
  }
}

async function postSubscription(subscription: PushSubscription): Promise<void> {
  const url = `${config.apiBase.replace(/\/$/, '')}/web-push/subscribe`;
  const body = JSON.stringify({ subscription: subscription.toJSON() });
  const auth = await buildNip98AuthHeader(url, 'POST', body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body,
  });
  if (!res.ok) {
    throw new Error(`subscribe failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
}

async function postUnsubscribe(endpoint: string): Promise<void> {
  const url = `${config.apiBase.replace(/\/$/, '')}/web-push/unsubscribe`;
  const body = JSON.stringify({ endpoint });
  const auth = await buildNip98AuthHeader(url, 'POST', body);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body,
  }).catch(() => undefined);
}

/** Decode the VAPID public key (base64url) into the Uint8Array that
 *  pushManager.subscribe expects via applicationServerKey. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
