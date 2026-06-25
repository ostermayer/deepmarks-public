// Background drain for the durable publish queue.
//
// The queue used to drain only while the popup was open: a save made
// while the API was unreachable showed "saved", the popup closed, and
// the bookmark sat local-only until the user happened to reopen the
// popup unlocked. The background service worker retries on a chrome
// alarm instead, using the same locked-state guards as the archive
// backfill service.

import { nsecStore } from './nsec-store.js';
import { drainPendingPublishes } from './pending-publish.js';

const ALARM_NAME = 'deepmarks-pending-publish-drain';

let installed = false;
let running = false;

export function startPendingPublishDrainService(): void {
  if (installed) return;
  installed = true;
  createAlarm({ periodInMinutes: 2 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runPendingPublishDrain();
  });
  setTimeout(() => {
    void runPendingPublishDrain();
  }, 5_000);
}

export async function runPendingPublishDrain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Offline drains can't succeed and would burn the bounded attempt
    // budget; the next alarm fires soon enough.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const account = await nsecStore.getState();
    if (!account.pubkey || !account.nsecHex || account.locked) return;
    await drainPendingPublishes(account.nsecHex, account.pubkey);
  } catch {
    // Transient — the next alarm retries.
  } finally {
    running = false;
  }
}

function createAlarm(info: chrome.alarms.AlarmCreateInfo): void {
  Promise.resolve(chrome.alarms.create(ALARM_NAME, info)).catch(() => undefined);
}
