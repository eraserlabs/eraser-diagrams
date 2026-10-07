# Security

If you believe you have found a security vulnerability in this repository or its published packages, please email hello@eraser.io rather than opening a public issue. We will respond as quickly as we can.

## SVG icons

Icons returned by custom loaders or fetched from icon hosts are untrusted. The resolver parses them with HTML parsing rules matching the renderer's `innerHTML` sink, validates a static SVG element and attribute allowlist, and serializes the validated tree. Fetch-time normalization applies the same validation after its transformations.

The supported subset includes paths, shapes, text, gradients, clipping, masks, and local fragment references. Scripts, event handlers, nested SVG roots, foreign HTML, animation, images, external references, and unsupported CSS are rejected. Inline styles are limited to presentation properties and simple values. Inputs are limited to 64 KiB of UTF-8 and 64 levels of nesting. Unsupported icons follow the existing unknown-icon policy (placeholder or error) and are negatively cached. Custom icon authors may need to flatten unsupported artwork to static paths.
