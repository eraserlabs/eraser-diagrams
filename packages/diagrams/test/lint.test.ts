import { describe, it, expect } from 'vitest';
import type { TemplateFile } from '@eraserlabs/protocol';
import {
  prepareLibrary,
  RegistryError,
  LINT_RULE,
  type AuthoredLibrary,
  type LintRule,
} from '@eraserlabs/resolve';
import { stockLibrary } from '../src/library/index.js';

/** Build a library whose Shape template is replaced by a deliberately broken one. */
function withBrokenShape(html: string, css = '.x{}'): AuthoredLibrary {
  const templates: TemplateFile[] = stockLibrary.templates.map((t) =>
    t.name === 'Shape' ? { name: 'Shape', html, css } : t,
  );

  return { ...stockLibrary, templates };
}

function rulesFor(fn: () => void): LintRule[] {
  try {
    fn();

    return [];
  } catch (e) {
    if (!(e instanceof RegistryError)) {
      throw e;
    }

    return e.issues.map((i) => i.rule);
  }
}

describe('template linter (each rule proven by a broken fixture)', () => {
  it('accepts the clean stock pack', () => {
    expect(() => prepareLibrary(stockLibrary)).not.toThrow();
  });

  it('duplicate-template-name — an override may replace but never duplicate', () => {
    const library = withBrokenShape(stockLibrary.templates.find((t) => t.name === 'Shape')!.html);
    library.templates.push({ ...library.templates.find((t) => t.name === 'Shape')! });
    const rules = rulesFor(() => prepareLibrary(library));
    expect(rules).toContain(LINT_RULE.DUPLICATE_NAME);
  });

  it('missing-element-kind — every dispatchable tag declares its kind in the schema', () => {
    const library = withBrokenShape(
      '<template name="Shape"><div data-tpl="Shape" data-role="body"></div></template>',
    );
    library.schemas = {
      ...library.schemas,
      Shape: {
        ...(library.schemas['Shape'] as Record<string, unknown>),
        'x-schema-kind': undefined,
      },
    };

    expect(rulesFor(() => prepareLibrary(library))).toContain(LINT_RULE.MISSING_ELEMENT_KIND);
  });

  it('root-tpl-mismatch — data-tpl must equal the template name', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Wrong" data-role="body"></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.ROOT_TPL_MISMATCH);
  });

  it('unknown-role + body-role-count — bad role also leaves the template bodyless', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="nonsense"></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.UNKNOWN_ROLE);
    expect(rules).toContain(LINT_RULE.BODY_ROLE_COUNT);
  });

  it('unknown-placeholder — placeholder must be a schema prop', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body">{{nope}}</div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.UNKNOWN_PLACEHOLDER);
  });

  it('each-grammar — data-each requires data-key', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body"><ul data-each="t of texts"><li>{{t.text}}</li></ul></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.EACH_GRAMMAR);
  });

  it('forbidden-markup — declarative shadow-root attribute', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body"><template shadowrootmode="open"><span>x</span></template></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.FORBIDDEN_MARKUP);
  });

  it('forbidden-css — scoping selectors (:host, :scope) may not be authored', () => {
    for (const css of [
      ':host{display:block}',
      ':scope{display:block}',
      '@scope(.x){.y{color:red}}',
    ]) {
      const rules = rulesFor(() =>
        prepareLibrary(
          withBrokenShape(
            '<template name="Shape"><div data-tpl="Shape" data-role="body"></div></template>',
            css,
          ),
        ),
      );
      expect(rules, css).toContain(LINT_RULE.FORBIDDEN_CSS);
    }
  });

  it('forbidden-markup — script tag', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body"><script></script></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.FORBIDDEN_MARKUP);
  });

  it('forbidden-css — @font-face in template CSS', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body"></div></template>',
          '@font-face{font-family:x}',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.FORBIDDEN_CSS);
  });

  it('content-in-attribute — a content-typed prop may not sit in an attribute value', () => {
    // Shape.texts carries x-content ('texts' head); an enum prop like styleMode stays legal there.
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body" title="{{texts}}"></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.CONTENT_IN_ATTRIBUTE);
  });

  it('content-in-attribute — enum props in attribute position stay legal', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body" class="er-style--{{styleMode}}"></div></template>',
        ),
      ),
    );
    expect(rules).not.toContain(LINT_RULE.CONTENT_IN_ATTRIBUTE);
  });

  it('style bindings — color/palette/number-typed props may bind --er-* custom properties', () => {
    // `color` is x-palette: both arms of its union land in the CSS-color domain, so it is
    // style-bindable exactly like the x-css-color `bgColor` beside it.
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body" style="--er-color: {{color}}; --er-bg: {{bgColor}}; --er-icon-pad: {{iconPadding}}px"><ul data-each="t of texts" data-key="text"><li style="--er-ink: {{t.color}}">{{t.text}}</li></ul></div></template>',
        ),
      ),
    );
    expect(rules).toEqual([]);
  });

  it('style bindings — a content-typed path may not bind a style custom property', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body"><ul data-each="t of texts" data-key="text"><li style="--er-ink: {{t.text}}">{{t.text}}</li></ul></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.FORBIDDEN_MARKUP);
  });

  it('unquoted-attribute — attribute values must be quoted', () => {
    const rules = rulesFor(() =>
      prepareLibrary(
        withBrokenShape(
          '<template name="Shape"><div data-tpl="Shape" data-role="body" class=er-shape></div></template>',
        ),
      ),
    );
    expect(rules).toContain(LINT_RULE.UNQUOTED_ATTRIBUTE);
  });
});
