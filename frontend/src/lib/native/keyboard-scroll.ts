import { browser } from '$app/environment';
import { isNativeShell } from '$lib/native/runtime';

const TEXT_ENTRY_SELECTOR = [
  'textarea',
  'select',
  '[contenteditable="true"]',
  'input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="hidden"]):not([type="image"]):not([type="radio"]):not([type="range"]):not([type="reset"]):not([type="submit"])',
].join(',');

const KEYBOARD_OPEN_THRESHOLD = 90;
const VIEWPORT_MARGIN = 18;

export function installNativeKeyboardAvoidance(): () => void {
  if (!browser || !isNativeShell()) return () => {};

  let disposed = false;
  let activeElement: HTMLElement | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  const visualViewport = window.visualViewport;

  function currentKeyboardInset(): number {
    const height = visualViewport?.height ?? window.innerHeight;
    const offsetTop = visualViewport?.offsetTop ?? 0;
    return Math.max(0, Math.round(window.innerHeight - height - offsetTop));
  }

  function updateKeyboardState(): void {
    if (disposed) return;
    const inset = currentKeyboardInset();
    document.documentElement.style.setProperty('--native-keyboard-inset-bottom', `${inset}px`);
    document.body.classList.toggle('native-keyboard-open', inset > KEYBOARD_OPEN_THRESHOLD);
  }

  function textEntryFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    const match = target.closest(TEXT_ENTRY_SELECTOR);
    return match instanceof HTMLElement ? match : null;
  }

  function scrollIntoVisibleViewport(element: HTMLElement): void {
    if (disposed || document.activeElement !== element) return;
    updateKeyboardState();

    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportHeight = visualViewport?.height ?? window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;
    const rect = element.getBoundingClientRect();
    const topLimit = viewportTop + VIEWPORT_MARGIN;
    const bottomLimit = viewportBottom - VIEWPORT_MARGIN;

    if (rect.top < topLimit || rect.bottom > bottomLimit) {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  }

  function scheduleFocusedScroll(element = activeElement): void {
    if (!element || disposed) return;
    window.requestAnimationFrame(() => scrollIntoVisibleViewport(element));
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scrollIntoVisibleViewport(element);
    }, 280);
  }

  function onFocusIn(event: FocusEvent): void {
    activeElement = textEntryFromTarget(event.target);
    if (!activeElement) return;
    setTimeout(() => scheduleFocusedScroll(activeElement), 80);
  }

  function onFocusOut(): void {
    activeElement = null;
    window.setTimeout(updateKeyboardState, 120);
  }

  function onViewportChange(): void {
    updateKeyboardState();
    scheduleFocusedScroll();
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('orientationchange', onViewportChange);
  visualViewport?.addEventListener('resize', onViewportChange);
  visualViewport?.addEventListener('scroll', onViewportChange);
  updateKeyboardState();

  return () => {
    disposed = true;
    if (scrollTimer) clearTimeout(scrollTimer);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('orientationchange', onViewportChange);
    visualViewport?.removeEventListener('resize', onViewportChange);
    visualViewport?.removeEventListener('scroll', onViewportChange);
    document.documentElement.style.removeProperty('--native-keyboard-inset-bottom');
    document.body.classList.remove('native-keyboard-open');
  };
}
