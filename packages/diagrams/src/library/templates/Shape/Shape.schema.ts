import {
  entitySchema,
  ShapeStyleProps,
  WashTexProps,
  MarkdownTextProperties,
  BadgeProperties,
  IconProps,
  FontSizePx,
  CssColor,
  ALLOWED_SHAPES,
  V_ALIGNS,
} from '../../schema/index.js';
import { IconName } from '../_shared/schema-parts.js';

export const Shape = entitySchema(
  'Shape',
  {
    shape: { type: 'string', enum: [...ALLOWED_SHAPES], default: 'rectangle' },
    ...ShapeStyleProps,
    texts: { type: 'array', items: MarkdownTextProperties },
    icon: IconName,
    iconProps: IconProps,
    iconPadding: { type: 'number' },
    /** Derived: glyph ink — iconProps.color, else the primary run's color. */
    iconColor: CssColor,
    vAlign: { type: 'string', enum: [...V_ALIGNS], default: 'middle' },
    /** Extra px clearance for top/bottom-aligned content. */
    vMargin: { type: 'number' },
    /** Derived: wrap aspect target for the selected shape geometry. */
    textAspectRatio: { type: 'number' },
    fontSize: FontSizePx,
    badge: BadgeProperties,
    /** Derived: flat wash blob path + box (CSS fades body colour for paint). */
    /** Derived: texture stain (washTexCss / washTexGeo); neither set = flat blob fallback. */
    ...WashTexProps,
    washTexGeo: { type: 'boolean' },
    washUseW: { type: 'number' },
    washUseH: { type: 'number' },
    /** Derived: real-size geometry path, or staticGeo for template geometry. */
    geoPath: { type: 'string', pattern: '^[MLHVCAZ0-9,. \\-]+$' },
    geoCapPath: { type: 'string', pattern: '^[MLHVCAZ0-9,. \\-]+$' },
    geoWashFloorPath: { type: 'string', pattern: '^[MLHVCAZ0-9,. \\-]+$' },
    geoW: { type: 'number' },
    geoH: { type: 'number' },
    staticGeo: { type: 'boolean' },
    /** Derived: true boundary in the 0–100 frame for endpoint attachment. */
    outline: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['polygon', 'ellipse'] },
        vertices: {
          type: 'array',
          minItems: 3,
          items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        },
        cornerRadius: { type: 'number' },
        cornerRadiusPercent: { type: 'number' },
      },
    },
  },
  { required: ['x', 'y'] },
);
