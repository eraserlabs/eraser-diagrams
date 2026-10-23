import { describe, it, expect } from 'vitest';
import { buildHtmlDocument, standaloneContentPolicy } from '../src/html.js';

describe('standalone HTML content policy', () => {
  it('comes first in <head> and runs no script', () => {
    const html = buildHtmlDocument({ title: 'T', styles: ['a{}'], body: '<div></div>' });

    expect(
      html.startsWith(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>T</title>`,
      ),
    ).toBe(true);
    expect(html).not.toContain('script-src');
  });

  it('names each font source once, after data:', () => {
    expect(
      standaloneContentPolicy([
        'file:',
        'https://fonts.example.com',
        'file:',
        'http://127.0.0.1:8080',
        'http://[::1]:3000',
      ]),
    ).toContain(
      'font-src data: file: https://fonts.example.com http://127.0.0.1:8080 http://[::1]:3000;',
    );
  });

  it('rejects a font source that is not a scheme or an origin', () => {
    for (const source of [
      "https://x.example; script-src 'unsafe-inline'",
      'https://x.example/"><script>',
      "'unsafe-inline'",
      '*',
      'https://x.example/fonts/',
    ]) {
      expect(() => standaloneContentPolicy([source]), source).toThrow('not a font source');
    }
  });
});
