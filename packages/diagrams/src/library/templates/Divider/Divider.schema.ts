import {
  entitySchema,
  FontSizePx,
  PaletteColor,
  TYPEFACES,
  ORIENTATIONS,
  BORDER_STYLES,
} from '../../schema/index.js';
import { PlainText } from '../_shared/schema-parts.js';

export const Divider = entitySchema(
  'Divider',
  {
    orientation: { type: 'string', enum: [...ORIENTATIONS] },
    label: PlainText,
    typeface: { type: 'string', enum: [...TYPEFACES] },
    fontSize: FontSizePx,
    /** Identity/stroke site: a palette token or a raw CSS color. */
    color: PaletteColor,
    lineStyle: { type: 'string', enum: [...BORDER_STYLES] },
    lineWidth: { type: 'number' },
    lineWidthPx: { type: 'number' },
  },
  { required: ['x', 'y', 'orientation'] },
);
