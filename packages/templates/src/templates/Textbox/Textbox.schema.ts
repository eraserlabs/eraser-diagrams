import {
  entitySchema,
  BadgeProperties,
  FontSizePx,
  CssColor,
  TYPEFACES,
  H_ALIGNS,
} from '../../schema/index.js';
import { MarkdownText } from '../_shared/schema-parts.js';

export const Textbox = entitySchema(
  'Textbox',
  {
    text: MarkdownText,
    color: CssColor,
    fontSize: FontSizePx,
    hAlign: { type: 'string', enum: [...H_ALIGNS] },
    typeface: { type: 'string', enum: [...TYPEFACES] },
    fixedWidth: { type: 'boolean' },
    badge: BadgeProperties,
    wrapMode: { type: 'string', enum: ['wrap', 'nowrap'] },
  },
  { required: ['x', 'y', 'text'] },
);
