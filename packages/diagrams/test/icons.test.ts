import { describe, it, expect } from 'vitest';
import { buildTestResolver } from './helper.js';

describe('unknown icon (US6)', () => {
  it('warns with a did-you-mean suggestion by default', async () => {
    const resolver = await buildTestResolver();
    // Suggestions come from the resolver's icon cache: only names a loader has served are known,
    // so warm the cache with the real name first.
    await resolver.resolve({
      elements: [{ tag: 'Icon', id: 'ok', x: 0, y: 0, icon: 'gcp-cloud-run' }],
    });
    const r = await resolver.resolve({
      elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'gcp-cloud-rum' }],
    });
    const w = r.warnings.find((w) => w.code === 'W_UNKNOWN_ICON');
    expect(w?.suggestion).toBe('gcp-cloud-run');
    expect(r.ok).toBe(true);
  });

  it('errors on unknown icon when configured', async () => {
    const resolver = await buildTestResolver({ onUnknownIcon: 'error' });
    const r = await resolver.resolve({
      elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'nope-nope' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'E_UNKNOWN_ICON')).toBe(true);
  });
});
