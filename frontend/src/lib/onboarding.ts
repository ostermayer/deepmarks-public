// localStorage flag set when the user has picked free-vs-lifetime at
// least once. Drives the post-sign-in redirect: missing flag → /welcome
// (tier picker), present → straight to /app or whatever the redirect
// target is. Set by /signup's choose-tier step and /welcome's pickTier.

import { browser } from '$app/environment';

export const TIER_CHOSEN_KEY = 'deepmarks-tier-chosen';

export function hasChosenTier(): boolean {
  if (!browser) return false;
  try {
    return localStorage.getItem(TIER_CHOSEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTierChosen(): void {
  if (!browser) return;
  try {
    localStorage.setItem(TIER_CHOSEN_KEY, '1');
  } catch {
    // private mode — no flag stored, user will see /welcome again on
    // next sign-in. Acceptable.
  }
}
