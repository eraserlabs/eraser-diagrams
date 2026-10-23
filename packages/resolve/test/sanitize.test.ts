import { describe, it, expect } from 'vitest';
import { buildSanitizers } from '../src/pipeline/sanitize.js';
import type { CodeHighlighter } from '../src/types.js';

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
    expect(s.markdown('a\\n\\nb').html).toBe('<p>a</p><p>b</p>');
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
  it('writes no newline between or after blocks: a run drawn with white-space pre shows none', () => {
    expect(s.markdown('# T\n\n- a\n- b').html).toBe('<h1>T</h1><ul><li>a</li><li>b</li></ul>');
    expect(s.inlineMarkdown('a\nb').html).not.toMatch(/\n/);
  });

  it('block: one newline is a line break, two a paragraph break, more an empty paragraph each', () => {
    expect(s.markdown('a\nb').html).toBe('<p>a<br />b</p>');
    expect(s.markdown('a\n\nb').html).toBe('<p>a</p><p>b</p>');
    expect(s.markdown('a\n\n\nb').html).toBe(`<p>a</p><p>${E}</p><p>b</p>`);
  });

  it('block: trailing newlines are trailing empty paragraphs', () => {
    expect(s.markdown('a\n').html).toBe(`<p>a</p><p>${E}</p>`);
    expect(s.markdown('a\n\n').html).toBe(`<p>a</p><p>${E}</p><p>${E}</p>`);
  });

  it('block: a list item breaks its own lines, not before the next item', () => {
    const out = s.markdown('- a\nstill a\n- b').html;
    expect(out).toContain('a<br />still a');
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it('writes no newline before or after a code block: the block sits right under the text before it', () => {
    expect(s.markdown('a\n\n```\nx\n```\n\nb').html).toBe(
      '<p>a</p><pre data-md="code-block"><code>x</code></pre><p>b</p>',
    );
  });

  it("block: a fenced code block's lines are its own", () => {
    const out = s.markdown('```ts\nconst a = 1\nconst b = 2\n```').html;
    expect(out).toBe(
      '<pre data-md="code-block"><code class="language-ts">const a = 1\nconst b = 2</code></pre>',
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
    expect(s.markdown('#### Four').html).toBe('<h3>Four</h3>');
    expect(s.markdown('###### Six').html).toBe('<h3>Six</h3>');
    expect(s.markdown('## Two').html).toBe('<h2>Two</h2>');
  });

  it('keeps quotes, rules, strikethrough and fenced code', () => {
    expect(s.markdown('> q').html).toBe('<blockquote><p>q</p></blockquote>');
    expect(s.markdown('a\n\n---\n\nb').html).toBe('<p>a</p><hr /><p>b</p>');
    expect(s.markdown('~~gone~~').html).toBe('<p><del>gone</del></p>');
    expect(s.inlineMarkdown('~~gone~~').html).toBe('<del>gone</del>');
    expect(s.markdown('```\nx\n```').html).toBe('<pre data-md="code-block"><code>x</code></pre>');
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
    expect(s.markdown('```\na\n\nb\n```').html).toContain('<code>a\n\nb</code>');
  });

  it('four leading spaces are text, not an indented code block', () => {
    expect(s.markdown('    four leading spaces').html).toBe('<p>    four leading spaces</p>');
    expect(s.markdown('a\n\n    b').html).toBe('<p>a</p><p>    b</p>');
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

describe('complete inline syntax', () => {
  for (const policy of ['markdown', 'inlineMarkdown'] as const) {
    it(`${policy}: preserves code-span whitespace while breaking surrounding prose`, () => {
      const out = s[policy](
        'Run `git commit -m "Update customer\nbilling settings"`\nthen continue.',
      );
      expect(out.html).toContain('<code>git commit -m "Update customer billing settings"</code>');
      expect(out.html).toContain('</code><br />then continue.');
    });

    it(`${policy}: leaves link destinations and titles to the Markdown parser`, () => {
      const out = s[policy](
        'Read [the docs](\nhttps://example.com/docs\n"Documentation"\n)\nthen continue.',
      );
      expect(out.html).toContain('<a href="https://example.com/docs" data-md="link">the docs</a>');
      expect(out.html).toContain('</a><br />then continue.');
    });
  }

  it('preserves ordinary multiline blockquotes and their inline marks', () => {
    expect(s.markdown('> **Warning**\n> Retry the request.').html).toBe(
      '<blockquote><p><strong>Warning</strong><br />Retry the request.</p></blockquote>',
    );
  });
});

describe("code block highlighting: the host's highlighter", () => {
  // A stand-in for the host's highlight.js: `const` is a keyword, a digit a number, the rest plain.
  const keywords: CodeHighlighter = (code) =>
    code.split(/(const|\d)/).filter(Boolean).map((text) =>
      text === 'const'
        ? { text, className: 'hljs-keyword' }
        : /\d/.test(text)
          ? { text, className: 'hljs-number' }
          : { text },
    );
  const code = (sanitizers: ReturnType<typeof buildSanitizers>, md: string) =>
    sanitizers.markdown(md).html.replace(/^<pre data-md="code-block"><code[^>]*>|<\/code><\/pre>$/g, '');

  it('wraps each coloured run, keeps the newlines between runs, and never reads as stripped', () => {
    const hl = buildSanitizers(keywords);
    const out = hl.markdown('```ts\nconst a = 1\nconst b = 2\n```');
    expect(out.html).toBe(
      '<pre data-md="code-block"><code class="language-ts">' +
        '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>\n' +
        '<span class="hljs-keyword">const</span> b = <span class="hljs-number">2</span></code></pre>',
    );
    expect(out.stripped).toBe(false);
  });

  it('passes the fence language, and an empty one for a bare fence', () => {
    const seen: string[] = [];
    const hl = buildSanitizers((text, language) => {
      seen.push(language);
      return [{ text }];
    });
    hl.markdown('```python extra\nx\n```');
    hl.markdown('```\nx\n```');
    expect(seen).toEqual(['python', '']);
  });

  it('escapes the runs', () => {
    const hl = buildSanitizers((text) => [{ text, className: 'hljs-tag' }]);
    const out = hl.markdown('```xml\n<script>alert(1)</script>\n```');
    expect(out.html).not.toContain('<script');
    expect(out.html).toContain('<span class="hljs-tag">&lt;script&gt;');
  });

  it('draws the plain text when the highlighter throws or its runs change the text', () => {
    const throws = buildSanitizers(() => {
      throw new Error('no');
    });
    expect(code(throws, '```\nconst a\n```')).toBe('const a');
    const changes = buildSanitizers(() => [{ text: 'other', className: 'hljs-keyword' }]);
    expect(code(changes, '```\nconst a\n```')).toBe('const a');
  });

  it('drops a class outside the highlight.js family, and that reads as stripped', () => {
    const out = buildSanitizers((text) => [{ text, className: 'evil' }]).markdown('```\nx\n```');
    expect(out.html).toBe('<pre data-md="code-block"><code><span>x</span></code></pre>');
    expect(out.stripped).toBe(true);
  });

  it('leaves inline code alone', () => {
    expect(buildSanitizers(keywords).inlineMarkdown('`const a`').html).toBe('<code>const a</code>');
  });
});
