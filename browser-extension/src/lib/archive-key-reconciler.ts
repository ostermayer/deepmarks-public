import { listAllMyArchives } from './archive.js';
import { countPendingArchiveKeys, reconcileArchiveKeys } from './archive-keys.js';
import { nsecStore } from './nsec-store.js';

const ALARM_NAME = 'deepmarks-archive-key-reconcile';

let installed = false;
let running = false;

export interface ArchiveKeyReconcileResult {
  reconciled: number;
  abandoned: number;
  pending: number;
}

export function startArchiveKeyReconcileService(): void {
  if (installed) return;
  installed = true;
  createAlarm({ periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void reconcilePendingArchiveKeys();
  });
  setTimeout(() => {
    void reconcilePendingArchiveKeys();
  }, 5_000);
}

export function scheduleArchiveKeyReconcileSoon(delayInMinutes = 1): void {
  createAlarm({ delayInMinutes, periodInMinutes: 5 });
}

export async function reconcilePendingArchiveKeys(force = false): Promise<ArchiveKeyReconcileResult> {
  const pendingBefore = await countPendingArchiveKeys();
  if (!force && pendingBefore === 0) {
    return { reconciled: 0, abandoned: 0, pending: 0 };
  }
  if (running) {
    return { reconciled: 0, abandoned: 0, pending: pendingBefore };
  }

  running = true;
  try {
    const account = await nsecStore.getState();
    if (!account.pubkey || !account.nsecHex || account.locked) {
      return { reconciled: 0, abandoned: 0, pending: pendingBefore };
    }

    const archives = await listAllMyArchives(account.nsecHex);
    const result = await reconcileArchiveKeys(archives, account.nsecHex, account.pubkey);
    return {
      reconciled: result.reconciled,
      abandoned: result.abandoned,
      pending: await countPendingArchiveKeys(),
    };
  } finally {
    running = false;
  }
}

function createAlarm(info: chrome.alarms.AlarmCreateInfo): void {
  Promise.resolve(chrome.alarms.create(ALARM_NAME, info)).catch(() => undefined);
}
