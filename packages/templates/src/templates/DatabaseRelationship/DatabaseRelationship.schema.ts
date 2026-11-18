import {
  connectionSchema,
  ConnectionBase,
  NOTATIONS,
  REL_TYPES,
  ARROWHEADS,
  CONNECTOR_STYLES,
  type JsonSchema,
} from '../../schema/index.js';
import { PlainText } from '../_shared/schema-parts.js';

const Arrowhead: JsonSchema = {
  anyOf: [{ type: 'string', enum: [...ARROWHEADS] }, { type: 'null' }],
};

export const DatabaseRelationship = connectionSchema('DatabaseRelationship', {
  ...ConnectionBase,
  fromField: PlainText,
  toField: PlainText,
  relType: { type: 'string', enum: [...REL_TYPES] },
  notation: { type: 'string', enum: [...NOTATIONS] },
  /** Derived (normalizers.ts) from relType — the crow-foot pair the template renders. */
  startArrowhead: Arrowhead,
  endArrowhead: Arrowhead,
  connectorStyle: { type: 'string', enum: [...CONNECTOR_STYLES] },
  /** An arc's signed distance from the chord's middle to its apex, in px. */
  bend: { type: 'number' },
});
