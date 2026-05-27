import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// $app/environment is a SvelteKit virtual module; stub it to look like a browser.
vi.mock('$app/environment', () => ({ browser: true }));

let store: HTMLElement;
beforeEach(() => {
  // Fresh fake DOM for each test — only the bits the store touches.
  const html = { dataset: {}, _attrs: new Map<string, string>() } as unknown as HTMLElement & {
    _attrs: Map<string, string>;
  };
  (html as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute = (k, v) => {
    (html as unknown as { _attrs: Map<string, string> })._attrs.set(k, v);
  };
  (html as unknown as { removeAttribute: (k: string) => void }).removeAttribute = (k) => {
    (html as unknown as { _attrs: Map<string, string> })._attrs.delete(k);
  };
  (html as unknown as { getAttribute: (k: string) => string | null }).getAttribute = (k) =>
    (html as unknown as { _attrs: Map<string, string> })._attrs.get(k) ?? null;
  vi.stubGlobal('document', { documentElement: html });
  vi.stubGlobal('localStorage', new MapBackedStorage());
  store = html;
});

class MapBackedStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe('theme store', () => {
  it('starts in auto when nothing is saved', async () => {
    const { theme } = await import('./theme.js');
    expect(get(theme)).toBe('auto');
  });

  it('persists explicit choices and writes [data-theme] on the html element', async () => {
    const { theme } = await import('./theme.js');
    theme.set('dark');
    expect(localStorage.getItem('deepmarks-theme')).toBe('dark');
    expect((store as unknown as { _attrs: Map<string, string> })._attrs.get('data-theme')).toBe('dark');
    theme.set('light');
    expect(localStorage.getItem('deepmarks-theme')).toBe('light');
  });

  it('clears persistence and the attribute when set to auto', async () => {
    const { theme } = await import('./theme.js');
    theme.set('dark');
    theme.set('auto');
    expect(localStorage.getItem('deepmarks-theme')).toBeNull();
    expect((store as unknown as { _attrs: Map<string, string> })._attrs.has('data-theme')).toBe(false);
  });

  it('toggle cycles light → dark → auto → light', async () => {
    const { theme } = await import('./theme.js');
    theme.set('light');
    theme.toggle();
    expect(get(theme)).toBe('dark');
    theme.toggle();
    expect(get(theme)).toBe('auto');
    theme.toggle();
    expect(get(theme)).toBe('light');
  });
});
