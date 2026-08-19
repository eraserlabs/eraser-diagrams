/** Enum catalogs the stock library schemas are built from. */

// `circle`, `ellipse`, and `oval` are three distinct kinds — keep all three.
export const ALLOWED_SHAPES = [
  'rectangle',
  'parallelogram',
  'trapezoid',
  'diamond',
  'cylinder',
  'hexagon',
  'circle',
  'ellipse',
  'oval',
  'triangle',
  'document',
  'star',
] as const;

export const STYLE_MODES = ['plain', 'shadow', 'watercolor'] as const;

export const TYPEFACES = ['rough', 'clean', 'mono'] as const;

// Absence = no arrowhead; there is no 'none' member.
export const ARROWHEADS = [
  'arrow',
  'bar',
  'dot',
  'triangle',
  'crowFootSingle',
  'crowFootMany',
] as const;

export const PORTS = ['top', 'right', 'bottom', 'left'] as const;

export const NOTATIONS = ['crows-foot', 'chen'] as const;

export const REL_TYPES = ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] as const;

/**
 * Semantic icon sizes. Each host maps tokens to px in its stylesheet — same token, different
 * box per slot, no resolve-time rewriting.
 */
export const ICON_SIZE_PRESETS = ['sm', 'md', 'lg', 'xl'] as const;

export const BORDER_STYLES = ['solid', 'dashed', 'dotted'] as const;

export const H_ALIGNS = ['left', 'center', 'right'] as const;

export const V_ALIGNS = ['top', 'middle', 'bottom'] as const;

export const ORIENTATIONS = ['horizontal', 'vertical'] as const;

export const BADGE_SHAPES = ['circle', 'rectangle'] as const;

/** Corner placements for node badges; start/middle/end for connection badges. */
export const BADGE_PLACEMENTS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'start',
  'middle',
  'end',
] as const;

export const CONNECTOR_STYLES = ['elbow', 'straight'] as const;

export const CORNER_STYLES = ['straight', 'elbow'] as const;

export const LABEL_WRAP_MODES = ['auto', 'nowrap'] as const;

export const GROUP_TITLE_WIDTHS = ['snug', 'full', 'none'] as const;
