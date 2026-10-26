import { CssColor, type JsonSchema } from '@eraserlabs/resolve/schema';

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

/** Kept separate from tagSchemas so rendering details do not enter the authoring contract. */
export const stockRenderProps: Record<string, Record<string, JsonSchema>> = {
  Shape: { ...surfacePaints, ...washPaints, bodyInk: CssColor },
  Legend: surfacePaints,
  Activity: surfacePaints,
  Event: surfacePaints,
  Gateway: surfacePaints,
  Group: groupPaints,
  Lane: groupPaints,
  Pool: groupPaints,
  DatabaseTable: { ...surfacePaints, ...washPaints, dividerColor: CssColor },
};
