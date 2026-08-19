import { describe, it, expect } from 'vitest';
import { buildSanitizers } from '../src/pipeline/sanitize.js';

const s = buildSanitizers();

describe('content policies', () => {
  it('plain escapes all HTML metacharacters', () => {
    expect(s.plain('<b>hi</b> & "x"')).toBe('&lt;b&gt;hi&lt;/b&gt; &amp; &quot;x&quot;');
  });

  it('plain neutralizes a </script> break-out attempt', () => {
    expect(s.plain('</script><script>alert(1)</script>')).not.toContain('<script');
    expect(s.plain('</script>')).toBe('&lt;/script&gt;');
  });

  it('markdown escapes raw HTML to literal text', () => {
    const out = s.markdown('# Title\n\n<script>alert(1)</script>\n\n**bold**');
    expect(out.html).not.toContain('<script');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).toContain('<h1>Title</h1>');
    expect(out.html).toContain('<strong>bold</strong>');
    expect(out.stripped).toBe(false);
  });

  it('benign markdown transforms without the stripped flag', () => {
    const out = s.markdown('# Title\n\n- a\n- b\n\n[link](https://x.io)');
    expect(out.html).toContain('<h1>Title</h1>');
    expect(out.html).toContain('<li>a</li>');
    expect(out.html).toContain('<a href="https://x.io">link</a>');
    expect(out.stripped).toBe(false);
  });

  it('inline-markdown parses marks but keeps block starters literal', () => {
    const out = s.inlineMarkdown('# not a heading, **bold**, `code`');
    expect(out.html).not.toContain('<h1');
    expect(out.html).toContain('# not a heading');
    expect(out.html).toContain('<strong>bold</strong>');
    expect(out.html).toContain('<code>code</code>');
    expect(out.stripped).toBe(false);
  });

  it('both markdown policies treat the literal \\n escape as a newline', () => {
    expect(s.markdown('a\\n\\nb').html).toBe('<p>a</p>\n<p>b</p>\n');
    expect(s.inlineMarkdown('a\\nb').html).toContain('a\nb');
  });

  it('html keeps allowlisted tags and discards the rest', () => {
    const out = s.html('<p>ok</p><img src=x onerror=alert(1)><iframe></iframe><b>b</b>');
    expect(out).toContain('<p>ok</p>');
    expect(out).toContain('<b>b</b>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('onerror');
  });

  it('html drops javascript: links', () => {
    const out = s.html('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
  });
});
