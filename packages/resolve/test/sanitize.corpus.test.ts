import { describe, it, expect } from 'vitest';
import { buildSanitizers } from '../src/pipeline/sanitize.js';

// ~50 XSS vectors (OWASP / PortSwigger flavored). Each is run through all three content policies.
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
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<object data="javascript:alert(1)">',
  '<embed src="data:text/html,<script>alert(1)</script>">',
  '<form action="javascript:alert(1)"><button>x',
  '<input onfocus=alert(1) autofocus>',
  '<select onfocus=alert(1) autofocus>',
  '<textarea onfocus=alert(1) autofocus>',
  '<video><source onerror=alert(1)>',
  '<audio src=x onerror=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<marquee onstart=alert(1)>',
  '"><script>alert(1)</script>',
  "'><script>alert(1)</script>",
  '</title><script>alert(1)</script>',
  '</textarea><script>alert(1)</script>',
  '</style><script>alert(1)</script>',
  '<div style="background:url(javascript:alert(1))">',
  '<div style="width:expression(alert(1))">',
  '<base href="//evil/">',
  '<meta http-equiv=refresh content="0;url=javascript:alert(1)">',
  '<link rel=import href="//evil">',
  '<math><mtext><script>alert(1)</script>',
  '<xss onmouseover=alert(1)>xss',
  '<a href=" javascript:alert(1)">lead space</a>',
  '<img src=`x`onerror=alert(1)>',
  '<img src=x:alert(1) onerror=eval(src)>',
  'javascript:alert(document.cookie)',
  '<p onclick=alert(1)>click</p>',
  '<span onmouseenter=alert(1)>hover</span>',
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<style>@import "//evil"</style>',
  '<template><script>alert(1)</script></template>',
  '<noscript><p title="</noscript><script>alert(1)</script>">',
  '<svg><use href="//evil#x"/></svg>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<img loading=lazy src=x onerror=alert(1)>',
  '<i></i><script>alert(1)</script>',
];

function isSafe(out: string): boolean {
  // Dangerous only when live: a script/embed tag, an event handler or dangerous-scheme URL inside
  // an actual tag, or a CSS expression(). Escaped markup rendered as visible text is inert — the
  // markdown policies deliberately keep hostile input visible (`&lt;img … onerror=…&gt;`).
  return (
    !/<script/i.test(out) &&
    !/<(iframe|object|embed|meta|base|link|style|foreignObject)[\s>]/i.test(out) &&
    !/<[a-z][^>]*\son\w+\s*=/i.test(out) &&
    !/<[a-z][^>]*(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data):/i.test(out) &&
    !/<[a-z][^>]*expression\s*\(/i.test(out)
  );
}

describe('sanitizer corpus (CI-blocking)', () => {
  const s = buildSanitizers();

  it('every vector is neutralized under all four content policies', () => {
    for (const v of XSS_VECTORS) {
      const plain = s.plain(v);
      expect(plain, `plain: ${v}`).not.toMatch(/[<>]/);
      expect(isSafe(s.markdown(v).html), `markdown: ${v}`).toBe(true);
      expect(isSafe(s.inlineMarkdown(v).html), `inline-markdown: ${v}`).toBe(true);
      expect(isSafe(s.html(v)), `html: ${v}`).toBe(true);
    }
  });

  it('a </script> break-out attempt in text is escaped by the plain policy', () => {
    expect(s.plain('</script><script>alert(1)</script>')).not.toContain('<script');
  });
});
