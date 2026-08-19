import { build } from 'esbuild';

const shared = {
  entryPoints: ['src/browser/index.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  // Shipped artifacts: minified, but with function/class names kept so page-side errors and
  // degraded-font reports still name their culprits.
  minify: true,
  keepNames: true,
  // The router reads process.env for its dev warnings and debug dumps (LayoutManager,
  // polylineUtils, fanSpreadRepair) — unguarded reads that would throw in a page. Substituting the
  // whole object keeps any future read inert instead of fatal.
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env': '{}',
  },
};

// Self-contained script for page injection (addInitScript in the orchestrator): the page is
// origin-less and cannot import, so this bundle inlines the router and everything else. The
// "./browser" ESM entry is NOT a bundle — bundler consumers get tsc's plain modules from the
// browser tsconfig pass and resolve @eraserlabs/layout themselves.
await build({
  ...shared,
  format: 'iife',
  outfile: 'dist/browser/eraser-render.iife.js',
});
