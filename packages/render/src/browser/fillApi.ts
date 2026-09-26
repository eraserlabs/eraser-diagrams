/**
 * The side-effect-free pieces of the browser renderer, for a host that draws one element at a time
 * in its own page (`@eraserlabs/render/fill`): the template fill, the elbow path, the label gap.
 * `./browser` (the page API) installs `window.__eraser` on import; this entry installs nothing.
 */
export { createFillEngine, type FillEngineInit, type FillFn } from './fill.js';
export { ELBOW_CORNER_RADIUS, toPathData } from './roundedPath.js';
export { clearLabelGap, cutLabelGap, type LabelGapOptions } from './labelGap.js';
