import { browser } from '$app/environment';
import { Capacitor } from '@capacitor/core';

export function isNativeShell(): boolean {
  return browser && Capacitor.isNativePlatform();
}

export function nativePlatform(): 'ios' | 'android' | 'web' {
  if (!isNativeShell()) return 'web';
  const platform = Capacitor.getPlatform();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}
