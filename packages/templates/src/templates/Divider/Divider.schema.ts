import {
  entitySchema,
  FontSizePx,
  PaletteColor,
  TYPEFACES,
  ORIENTATIONS,
  BORDER_STYLES,
} from '../../schema/index.js';

export const Divider = entitySchema(
  'Divider',
  {
    orientation: { type: 'string', enum: [...ORIENTATIONS] },
    /** The label, in the Labels group of the canvas text contract: inline markdown, as a connection's label. */
    label: { type: 'string', 'x-content': 'inline-markdown' },
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
