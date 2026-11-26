import { CssColor, type JsonSchema } from '@eraserlabs/resolve/schema';
import { TYPEFACES, H_ALIGNS, UNDERLINE_STYLES } from './enums.js';

/**
 * Explicit text size in px. Bound through gated attributes (`data-font-px` / `--er-font-px`) so
 * an absent value cannot void a declaration. Slot defaults live in CSS (`--er-base`).
 */
export const FontSizePx: JsonSchema = { type: 'number' };

/**
 * Property-level underline styling (keeps stored Markdown pure GFM): `true` or `'solid'` draws a
 * solid underline (Chen primary keys, UML static members); `'dashed'` draws a dashed underline
 * (Chen weak-entity partial keys).
 */
export type UnderlineStyle = boolean | (typeof UNDERLINE_STYLES)[number];
export const UnderlineStyle: JsonSchema = {
  anyOf: [{ type: 'boolean' }, { type: 'string', enum: [...UNDERLINE_STYLES] }],
};

/** A styled text run in an entity `texts` array (`x-content: markdown`). */
export const MarkdownTextProperties: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', 'x-content': 'markdown' },
    color: CssColor,
    fontSize: FontSizePx,
    hAlign: { type: 'string', enum: [...H_ALIGNS] },
    typeface: { type: 'string', enum: [...TYPEFACES] },
    underline: UnderlineStyle,
  },
};
