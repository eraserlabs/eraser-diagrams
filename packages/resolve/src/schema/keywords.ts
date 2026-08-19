import type { Ajv } from 'ajv';
import {
  ELEMENT_KINDS,
  ELEMENT_KIND_KEYWORD,
  CONTAINER_KEYWORD,
  METADATA_KEYWORDS,
} from '@eraserlabs/protocol/schema';

export {
  ELEMENT_KINDS,
  ELEMENT_KIND_KEYWORD,
  CONTAINER_KEYWORD,
  CONTENT_KEYWORD,
  CSS_COLOR_KEYWORD,
  ICON_NAME_KEYWORD,
  REF_KEYWORD,
  PALETTE_KEYWORD,
  PALETTE_TOKEN_PATTERN,
  METADATA_KEYWORDS,
  type ContentPolicy,
  type PolicyKind,
} from '@eraserlabs/protocol/schema';

/** Register protocol annotation keywords on AJV; this adapter remains resolver-specific. */
export function registerMetadataKeywords(ajv: Ajv): void {
  if (!ajv.getKeyword(ELEMENT_KIND_KEYWORD)) {
    ajv.addKeyword({
      keyword: ELEMENT_KIND_KEYWORD,
      schemaType: 'string',
      metaSchema: { enum: [...ELEMENT_KINDS] },
    });
  }

  if (!ajv.getKeyword(CONTAINER_KEYWORD)) {
    ajv.addKeyword({
      keyword: CONTAINER_KEYWORD,
      schemaType: 'boolean',
      metaSchema: { const: true },
    });
  }

  for (const [keyword, schemaType] of Object.entries(METADATA_KEYWORDS)) {
    if (!ajv.getKeyword(keyword)) {
      ajv.addKeyword({ keyword, schemaType, metaSchema: { type: [schemaType] } });
    }
  }
}
