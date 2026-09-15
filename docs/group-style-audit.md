# Stock group-style audit

Scope: `Group`, `Lane`, and `Pool`, through the stock resolver and Chromium renderer. The audit checks computed styles, text/icon geometry, screenshots, and exported PNG bounds.

## Findings

| Property or interaction | Result |
| --- | --- |
| `borderWidth` | Fixed: accepted by the schema but never bound into any group template. Explicit zero also works. |
| `cornerRadius` | Fixed: accepted but ignored. `round`, `sharp`, and four independent radii now apply. |
| Watercolor with dashed/dotted borders | Fixed: a solid watercolor overlay previously painted over the SVG dash pattern. The patterned outline now receives the watercolor treatment itself. |
| `color` and `bgColor` together in watercolor titles | Fixed: identity color could outrank explicit body paint when deriving the title surface. Explicit body paint now wins, including transparent/none. |
| Lane/Pool watercolor title positioning | Fixed: a shared watercolor rule changed the side title to relative positioning, stretching the container and overlapping adjacent rows. Side titles now remain absolute in every mode. |
| Lane/Pool `title.hAlign: left` | Fixed: the vertical title had no left/start alignment rule. Start is at the bottom of the sideways text; end is at the top. |
| Body `color`, `bgColor`, `borderColor` | Existing color bindings work; explicit paint wins over identity formulas. |
| `title.color`, `title.bgColor` | Existing explicit bindings work, including text color. Watercolor intentionally makes title paint translucent. |
| `title.width`, `title.border` | Snug, full, and none work. `border: false` removes the title border; `width: none` is plain text without a painted chip. |
| `title.fontSize`, `title.typeface` | Work; numeric font sizes and all three font roles are exercised. |
| `title.icon`, `title.iconProps.color`, `title.iconProps.size` | Work; explicit icon color and all four size presets are exercised. |
| `styleMode` | Plain, shadow, and watercolor are exercised across all three border styles and title widths. Transparent and patterned bodies suppress the offset shadow. |
| Hosted `badge` | Text, color, background, font size, padding, circular shape, and bottom-left placement render correctly in the audit. |

Authored border widths/corners use native CSS borders so geometry remains correct when layout resizes a group. Uncustomized dashed/dotted groups retain the existing SVG dash spacing. Border width controls the outer group outline; the title separator retains its own hairline.

## Watercolor PNG bounds (issue #1)

The renderer previously unioned every descendant DOM rectangle, including SVG definitions and oversized texture images whose paint is clipped away. This inflated export bounds without adding visible content. The fix skips inert SVG definitions and intersects painted geometry with ancestor overflow clips and SVG clip-path bounds. It keeps genuine overflowing badges and shadows.

The supplied 200 × 100 rectangle now exports at **464 × 264 pixels at scale 2**, in both plain and watercolor modes. A pixel scan checks all four margins. Regression tests also compare plain and watercolor exports for every stock shape kind plus Group, Lane, Pool, and DatabaseTable.

Measurement remains geometry-based: curved SVG clips use conservative bounding rectangles, and other CSS clip-path forms are not tightened. This is not a threshold-based crop of arbitrary pixels.

## Regression coverage

- `packages/diagrams/test/group-styles.spec.ts`: all 27 combinations of mode, border style, and title width per group template; authored geometry, transparency, title paint precedence, typography, icon sizes, alignment, and badge styling. Attaches a style-matrix screenshot per tag.
- `packages/diagrams/test/watercolor-bounds.spec.ts`: scale-2 PNG output for 16 stock kinds, including a pixel-margin check for the reported rectangle.
- `packages/render/test/ink-clipping.spec.ts`: inert definitions, clipped HTML/SVG overflow, transformed SVG clipping in both coordinate systems, and preservation of badge/shadow overflow.

## Validation result

- Workspace build passed.
- All 637 unit/integration tests passed.
- All 100 non-golden browser tests passed (19 render, 81 diagrams).
- Diagrams test typecheck, changed TypeScript lint, and whitespace checks passed.
- Group and Lane/Pool matrix screenshots were visually reviewed. The final side-band matrix has the same canvas height as the Group matrix, with no watercolor title overlap.
- The render package's separate test typecheck has existing errors in `test/outline.test.ts` and `test/route.test.ts`: both import `ResolvedEntity` and `ResolvedConnection` from the render entrypoint, which does not export those types. Those files are unchanged by this fix.

Stored golden snapshots were not regenerated; corrected watercolor bounds and side-title geometry can intentionally change affected snapshots.
