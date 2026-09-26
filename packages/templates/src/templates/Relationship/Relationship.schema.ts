import {
  connectionSchema,
  ConnectionBase,
  PORTS,
  ARROWHEADS,
  CONNECTOR_STYLES,
  CORNER_STYLES,
  type JsonSchema,
} from '../../schema/index.js';

const Arrowhead: JsonSchema = {
  anyOf: [{ type: 'string', enum: [...ARROWHEADS] }, { type: 'null' }],
};

export const Relationship = connectionSchema('Relationship', {
  ...ConnectionBase,
  fromPort: { type: 'string', enum: [...PORTS] },
  toPort: { type: 'string', enum: [...PORTS] },
  startArrowhead: Arrowhead,
  endArrowhead: { ...Arrowhead, default: 'triangle' },
  connectorStyle: { type: 'string', enum: [...CONNECTOR_STYLES] },
  cornerStyle: { type: 'string', enum: [...CORNER_STYLES], default: 'elbow' },
});
