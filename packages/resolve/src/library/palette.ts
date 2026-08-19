import { PALETTE_TOKEN_PATTERN } from '@eraserlabs/protocol/schema';
import { isValidColor } from '../pipeline/colors.js';
import { LINT_RULE, type LintIssue } from './lint.js';

/** Library-wide issues report under this pseudo-template name. */
const PALETTE = 'palette';

/**
 * Check a library's `palette` at boot and return it as a null-prototype map. A palette is inert
 * data — a hosted product may accept one from an untrusted profile author — so both halves of
 * every entry are constrained here rather than trusted downstream: token names to the identifier
 * charset (they only ever key a lookup and quote into a diagnostic), values to the same strict
 * CSS-color grammar authored colors pass, because a translated token goes straight into a CSS
 * custom property with no further validation between here and the page.
 */
export function checkPalette(
  palette: Record<string, string> | undefined,
  issues: LintIssue[],
): Record<string, string> | undefined {
  if (palette === undefined) {
    return undefined;
  }

  if (palette === null || typeof palette !== 'object' || Array.isArray(palette)) {
    issues.push({
      rule: LINT_RULE.PALETTE_SHAPE,
      template: PALETTE,
      message: 'palette must be an object mapping token names to CSS colors',
    });

    return undefined;
  }

  const checked: Record<string, string> = Object.create(null);

  for (const [token, color] of Object.entries(palette)) {
    if (!PALETTE_TOKEN_PATTERN.test(token)) {
      issues.push({
        rule: LINT_RULE.PALETTE_TOKEN_NAME,
        template: PALETTE,
        message: `token name ${quoteToken(token)} must match ${PALETTE_TOKEN_PATTERN.source}`,
      });
      continue;
    }

    if (typeof color !== 'string' || !isValidColor(color)) {
      issues.push({
        rule: LINT_RULE.PALETTE_COLOR,
        template: PALETTE,
        message: `token "${token}" must map to one CSS color, got ${quoteToken(color)}`,
      });
      continue;
    }

    checked[token] = color;
  }

  return checked;
}

/** Quote and truncate for a boot message; a rejected token name may be anything at all. */
function quoteToken(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);

  return `"${text.length > 40 ? `${text.slice(0, 37)}…` : text}"`;
}
