import { CssColor, type JsonSchema } from '@eraserlabs/resolve/schema';
import { TYPEFACES, H_ALIGNS } from './enums.js';

/**
 * Explicit text size in px. Bound through gated attributes (`data-font-px` / `--er-font-px`) so
 * an absent value cannot void a declaration. Slot defaults live in CSS (`--er-base`).
 */
export const FontSizePx: JsonSchema = { type: 'number' };

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
  },
};
