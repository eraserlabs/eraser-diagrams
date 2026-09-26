import { entitySchema, ShapeStyleProps, CssColor, type JsonSchema } from '../../schema/index.js';

const LegendEntry: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', 'x-content': 'plain' },
    color: CssColor,
  },
};

export const Legend = entitySchema(
  'Legend',
  {
    entries: { type: 'array', items: LegendEntry },
    ...ShapeStyleProps,
  },
  { required: ['x', 'y'] },
);
