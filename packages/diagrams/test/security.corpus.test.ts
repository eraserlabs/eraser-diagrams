import { describe, it, expect, beforeAll } from 'vitest';
import type { Resolver } from '@eraserlabs/resolve';
import { allElements, buildTestResolver } from './helper.js';

// End-to-end vectors against the stock library. The full ~50-vector corpus runs against the
// sanitizers directly in @eraserlabs/resolve (test/sanitize.corpus.test.ts); this suite proves the
// stock pipeline neutralizes representative vectors through resolve().
const XSS_VECTORS = [
  '<script>alert(1)</script>',
  '<SCRIPT>alert(1)</SCRIPT>',
  '<script src=//evil/x.js></script>',
  '<img src=x onerror=alert(1)>',
  '<img src=x onerror="alert(1)">',
  '<svg onload=alert(1)>',
  '<svg/onload=alert(1)>',
  '<body onload=alert(1)>',
  '<iframe src="javascript:alert(1)">',
  '<iframe srcdoc="<script>alert(1)</script>">',
];

describe('security corpus — stock pipeline (CI-blocking)', () => {
  let resolver: Resolver;
  beforeAll(async () => {
    resolver = await buildTestResolver();
  });

  it('the markdown path (shape texts) neutralizes hostile markup to visible text', async () => {
    for (const v of XSS_VECTORS) {
      const r = await resolver.resolve({
        elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, texts: [{ text: v }] }],
      });
      expect(r.ok).toBe(true);
      expect(r.warnings.some((w) => w.code === 'W_CONTENT_SANITIZED')).toBe(true);

      // Raw HTML escapes to literal text — no live markup, escaped form stays visible.
      const payload = JSON.stringify(allElements(r));
      expect(payload, `raw markup leaked for: ${v}`).not.toMatch(/<(script|img|svg|body|iframe)/i);
      expect(payload, `escaped form missing for: ${v}`).toContain('&lt;');
    }
  });

  it('the plain path (database field names) escapes hostile text end-to-end', async () => {
    for (const v of XSS_VECTORS) {
      const r = await resolver.resolve({
        elements: [
          {
            tag: 'DatabaseTable',
            id: 't',
            x: 0,
            y: 0,
            title: 'T',
            fields: [{ name: v, type: 'int' }],
          },
        ],
      });
      expect(r.ok).toBe(true);

      // Plain policy: no raw metacharacter survives, and the vector is present escaped.
      const payload = JSON.stringify(allElements(r));
      expect(payload, `raw markup leaked for: ${v}`).not.toMatch(/[<>]/);
      expect(payload, `escaped form missing for: ${v}`).toContain('&lt;');
    }
  });

  it('CSS-injection via color fields is rejected', async () => {
    const payloads = [
      'red;} body{background:url(//evil)}',
      'red; }',
      'url(javascript:alert(1))',
      'expression(alert(1))',
      '#fff;color:red',
      'blue{',
    ];

    for (const p of payloads) {
      const r = await resolver.resolve({
        elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, bgColor: p }],
      });
      expect(r.ok, `should reject color: ${p}`).toBe(false);
      expect(r.errors.some((e) => e.code === 'E_INVALID_COLOR')).toBe(true);
    }
  });

  it('prototype-pollution keys are rejected anywhere', async () => {
    const hostile = JSON.parse(
      '{"elements":[{"tag":"Shape","id":"s","x":0,"y":0,"__proto__":{"polluted":true}}]}',
    );
    const r = await resolver.validate(hostile);
    expect(r.errors.some((e) => e.code === 'E_FORBIDDEN_KEY')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
