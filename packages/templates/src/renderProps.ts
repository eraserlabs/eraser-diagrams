import { CssColor, type JsonSchema } from '@eraserlabs/resolve/schema';
import { cornerRadiiProps } from './templates/_shared/schema-parts.js';

/** Normalizer output consumed by stock templates, not properties callers may author. */
const surfacePaints: Record<string, JsonSchema> = {
  fillColor: CssColor,
  tintColor: CssColor,
};

const washPaints: Record<string, JsonSchema> = {
  washPaper: { ...CssColor, pattern: '^#[0-9a-f]{6}$' },
};

const groupPaints: Record<string, JsonSchema> = {
  ...surfacePaints,
  ...washPaints,
  titleSurfaceColor: CssColor,
};

const tableRenderProps: Record<string, JsonSchema> = {
  ...surfacePaints,
  ...washPaints,
  ...cornerRadiiProps,
  dividerColor: CssColor,
};

/** Kept separate from tagSchemas so rendering details do not enter the authoring contract. */
export const stockRenderProps: Record<string, Record<string, JsonSchema>> = {
  Shape: {
    ...surfacePaints,
    ...washPaints,
    bodyInk: CssColor,
    geoShadowPath: { type: 'string', pattern: '^[MLHVQCAZ0-9,. \\-]+$' },
    geoShadowClip: { type: 'string', pattern: '^[MLHVQCAZ0-9,. \\-]+$' },
    geoInnerPath: { type: 'string', pattern: '^[MLHVQCAZ0-9,. \\-]+$' },
  },
  Legend: surfacePaints,
  Activity: surfacePaints,
  Event: surfacePaints,
  Gateway: surfacePaints,
  Group: groupPaints,
  Lane: groupPaints,
  Pool: { ...groupPaints, laneDividerPath: { type: 'string' } },
  DatabaseTable: tableRenderProps,
  ClassBox: tableRenderProps,
  Relationship: { startMarker: { type: 'string' }, endMarker: { type: 'string' } },
  DatabaseRelationship: { startMarker: { type: 'string' }, endMarker: { type: 'string' } },
};
