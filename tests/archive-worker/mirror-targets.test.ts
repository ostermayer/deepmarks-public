import { describe, expect, it } from 'vitest';
import { resolveMirrorTargets } from '@src/mirror-targets.js';

describe('resolveMirrorTargets', () => {
  it('merges operator and user Blossom servers as normalized https origins', async () => {
    const result = await resolveMirrorTargets({
      primaryUrl: 'https://1.1.1.1/',
      operatorUrls: ['https://8.8.8.8/path'],
      userUrls: ['https://9.9.9.9/anything?x=1'],
    });

    expect(result.urls).toEqual(['https://8.8.8.8', 'https://9.9.9.9']);
    expect(result.rejected).toEqual([]);
  });

  it('dedupes mirrors and skips the primary server', async () => {
    const result = await resolveMirrorTargets({
      primaryUrl: 'https://1.1.1.1/',
      operatorUrls: ['https://1.1.1.1/upload', 'https://8.8.8.8'],
      userUrls: ['https://8.8.8.8/again'],
    });

    expect(result.urls).toEqual(['https://8.8.8.8']);
  });

  it('reports unsafe or non-https mirrors without dropping valid mirrors', async () => {
    const result = await resolveMirrorTargets({
      primaryUrl: 'https://1.1.1.1/',
      operatorUrls: ['http://8.8.8.8'],
      userUrls: ['https://127.0.0.1', 'https://9.9.9.9'],
    });

    expect(result.urls).toEqual(['https://9.9.9.9']);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]).toMatchObject({ url: 'http://8.8.8.8', ok: false });
    expect(result.rejected[1]).toMatchObject({ url: 'https://127.0.0.1', ok: false });
  });
});
