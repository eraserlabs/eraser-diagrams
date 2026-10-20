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
    expect(out.html).toContain('<a href="https://x.io" data-md="link">link</a>');
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
    expect(s.inlineMarkdown('a\\nb').html).toBe('a<br />b');
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

const E = '\u200b';

describe('canvas newline rule', () => {
  it('block: one newline is a line break, two a paragraph break, more an empty paragraph each', () => {
    expect(s.markdown('a\nb').html).toBe('<p>a<br />b</p>\n');
    expect(s.markdown('a\n\nb').html).toBe('<p>a</p>\n<p>b</p>\n');
    expect(s.markdown('a\n\n\nb').html).toBe(`<p>a</p>\n<p>${E}</p>\n<p>b</p>\n`);
  });

  it('block: trailing newlines are trailing empty paragraphs', () => {
    expect(s.markdown('a\n').html).toBe(`<p>a</p>\n<p>${E}</p>\n`);
    expect(s.markdown('a\n\n').html).toBe(`<p>a</p>\n<p>${E}</p>\n<p>${E}</p>\n`);
  });

  it('block: a list item breaks its own lines, not before the next item', () => {
    const out = s.markdown('- a\nstill a\n- b').html;
    expect(out).toContain('a<br />still a');
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it("block: a fenced code block's lines are its own", () => {
    const out = s.markdown('```ts\nconst a = 1\nconst b = 2\n```').html;
    expect(out).toBe(
      '<pre data-md="code-block"><code class="language-ts">const a = 1\nconst b = 2</code></pre>\n',
    );
  });

  it('inline: lines as the canvas breaks a label, an empty line held open', () => {
    expect(s.inlineMarkdown('a\nb').html).toBe('a<br />b');
    expect(s.inlineMarkdown('a\n\nb').html).toBe('a<br />b');
    expect(s.inlineMarkdown('a\n\n\nb').html).toBe(`a<br />${E}<br />b`);
    expect(s.inlineMarkdown('a\n').html).toBe(`a<br />${E}`);
    expect(s.inlineMarkdown('').html).toBe('');
  });
});

describe('canvas text contract', () => {
  it('draws headings past h3 as h3', () => {
    expect(s.markdown('#### Four').html).toBe('<h3>Four</h3>\n');
    expect(s.markdown('###### Six').html).toBe('<h3>Six</h3>\n');
    expect(s.markdown('## Two').html).toBe('<h2>Two</h2>\n');
  });

  it('keeps quotes, rules, strikethrough and fenced code', () => {
    expect(s.markdown('> q').html).toBe('<blockquote>\n<p>q</p>\n</blockquote>\n');
    expect(s.markdown('a\n\n---\n\nb').html).toBe('<p>a</p>\n<hr />\n<p>b</p>\n');
    expect(s.markdown('~~gone~~').html).toBe('<p><del>gone</del></p>\n');
    expect(s.inlineMarkdown('~~gone~~').html).toBe('<del>gone</del>');
    expect(s.markdown('```\nx\n```').html).toBe('<pre data-md="code-block"><code>x</code></pre>\n');
    for (const md of ['> q', '---', '~~x~~', '```\nx\n```', 'a\nb', 'a\n\n\nb']) {
      expect(s.markdown(md).stripped, md).toBe(false);
    }
    expect(s.inlineMarkdown('a\nb').stripped).toBe(false);
  });

  it('puts the host hook on links and code blocks, and the language on the code', () => {
    expect(s.inlineMarkdown('[r](https://x.io/r)').html).toBe(
      '<a href="https://x.io/r" data-md="link">r</a>',
    );
    expect(s.markdown('```js injected\nx\n```').html).toContain('<code class="language-js">');
  });

  it('still discards what the contract rejects', () => {
    const table = s.markdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(table.html).not.toContain('<table');
    expect(table.stripped).toBe(true);
    const image = s.markdown('![alt](https://x.io/i.png)');
    expect(image.html).not.toContain('<img');
    expect(image.stripped).toBe(true);
    expect(s.markdown('<u>u</u>').html).toContain('&lt;u&gt;u&lt;/u&gt;');
    expect(s.markdown('[x](javascript:alert(1))').html).not.toContain('javascript:');
  });
});
