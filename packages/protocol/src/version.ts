/** Human-readable name of the protocol. */
export const PROTOCOL_NAME = 'Model Diagramming Protocol' as const;

/** Short namespace used by MDP-owned DOM attributes and schema annotations. */
export const PROTOCOL_ACRONYM = 'MDP' as const;

/** Current experimental protocol line. Breaking changes are allowed until 1.0. */
export const PROTOCOL_VERSION = '0.1' as const;

/** Stable identifier carried by versioned protocol artifacts. */
export const PROTOCOL_ID = `mdp/${PROTOCOL_VERSION}` as const;
