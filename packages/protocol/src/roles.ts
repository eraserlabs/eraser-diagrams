/**
 * Semantic `data-role` vocabulary shared by conforming templates and renderers.
 * `data-part` remains profile-defined and intentionally free-form.
 */
export const DATA_ROLES = ['body', 'anchor', 'badge', 'external-text', 'internal-text'] as const;

export type DataRole = (typeof DATA_ROLES)[number];

/** Tag-independent ways rendered text may respond when content exceeds its preferred box. */
export const TEXT_SIZE_POLICIES = ['balanced', 'width-only', 'height-only'] as const;

export type TextSizePolicy = (typeof TEXT_SIZE_POLICIES)[number];
