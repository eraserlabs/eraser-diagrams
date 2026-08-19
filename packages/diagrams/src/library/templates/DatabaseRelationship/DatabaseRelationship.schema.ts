import {
  connectionSchema,
  ConnectionBase,
  NOTATIONS,
  REL_TYPES,
  ARROWHEADS,
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
});
