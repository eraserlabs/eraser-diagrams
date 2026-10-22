/**
 * The Measure and Fit operations for a host that draws one element at a time in its own page
 * (`@eraserlabs/render/fit`): the element's filled template in a mount host (`data-mdp-tag`),
 * attached and unzoomed, is measured as laid out, or sized for its text under the host's
 * constraints. Neither installs anything on the page.
 */
export {
  type ElementFit,
  type FitConstraints,
  type FitPolicy,
  fitElement,
  measureElement,
  type Overflow,
  type TextRegionMeasure,
} from './textSizing.js';
