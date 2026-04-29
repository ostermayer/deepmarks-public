// Tiny in-memory router with a history stack so a back button has
// somewhere to go. The popup is a single-window surface — no URL
// bar — but users expect a back affordance, especially when they
// land on a deep screen (Sign-Request from a page prompt, Login
// from Onboarding).

import { useEffect, useState } from 'react';

export type Screen =
  | 'onboarding'
  | 'login'
  | 'set-password'  // shown right after Login on first sign-in / new key
  | 'unlock'        // shown when an encrypted account is locked
  | 'recent'
  | 'add'
  | 'sign-request'
  | 'settings';

// Stack: [bottom, …, top]. `top` = current screen.
let stack: Screen[] = ['recent'];
const listeners = new Set<(s: Screen) => void>();

function emit(): void {
  const s = stack[stack.length - 1]!;
  for (const fn of listeners) fn(s);
}

/** Push a new screen onto the history stack. */
export function navigate(to: Screen): void {
  // Avoid stacking duplicate consecutive entries — keeps the
  // back-button trail tidy if a route navigates to itself.
  if (stack[stack.length - 1] === to) return;
  stack.push(to);
  emit();
}

/** Replace the current screen instead of pushing. Used at boot to
 *  set the landing screen without leaving an "back to nothing"
 *  entry below it. */
export function replace(to: Screen): void {
  stack = [to];
  emit();
}

/** Pop the top screen. No-op when the stack is at the root. */
export function back(): void {
  if (stack.length <= 1) return;
  stack.pop();
  emit();
}

/** True when there's a previous screen — drives whether a back
 *  button should be visible. */
export function canGoBack(): boolean {
  return stack.length > 1;
}

export function getScreen(): Screen {
  return stack[stack.length - 1]!;
}

/** React hook — re-renders whenever the active screen changes. */
export function useScreen(): Screen {
  const [screen, setScreen] = useState<Screen>(getScreen());
  useEffect(() => {
    const fn = (s: Screen) => setScreen(s);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return screen;
}
