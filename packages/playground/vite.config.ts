import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { parse as parseYaml } from 'yaml';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const serverPort = process.env.SERVER_PORT ?? '8080';
const fixturesDir = resolve(here, '../../fixtures');

/**
 * Serve the workspace packages from SOURCE instead of dist: every specifier whose package export
 * targets dist is aliased to its src counterpart, so package edits (normalizers, the render
 * pipeline, templates via the codegen watcher below) join Vite's HMR graph — no tsc build, no
 * server restart. Exports that already target source files (protocol's JSON schemas) need no
 * alias. tsc typechecks against the real exports maps (dist), unchanged.
 */
const srcOf = (pkg: string, file: string): string => resolve(here, `../${pkg}/src/${file}`);
const workspaceSourceAliases = [
  {
    find: /^@eraserlabs\/diagrams\/normalizers$/,
    replacement: srcOf('diagrams', 'library/normalizers.ts'),
  },
  {
    find: /^@eraserlabs\/diagrams\/svg-transforms$/,
    replacement: srcOf('diagrams', 'icons/svgTransforms.ts'),
  },
  { find: /^@eraserlabs\/diagrams\/library$/, replacement: srcOf('diagrams', 'library/index.ts') },
  { find: /^@eraserlabs\/render\/browser$/, replacement: srcOf('render', 'browser/index.ts') },
  { find: /^@eraserlabs\/render$/, replacement: srcOf('render', 'index.ts') },
  { find: /^@eraserlabs\/resolve\/schema$/, replacement: srcOf('resolve', 'schema/index.ts') },
  { find: /^@eraserlabs\/resolve$/, replacement: srcOf('resolve', 'index.ts') },
  { find: /^@eraserlabs\/protocol\/schema$/, replacement: srcOf('protocol', 'schema.ts') },
  { find: /^@eraserlabs\/protocol$/, replacement: srcOf('protocol', 'index.ts') },
  { find: /^@eraserlabs\/layout$/, replacement: srcOf('layout', 'index.ts') },
  { find: /^@eraserlabs\/utils$/, replacement: srcOf('utils', 'index.ts') },
];

const SCENARIOS = [
  { id: 'minimal-shape', label: 'Minimal shape', description: 'A single Shape.' },
  {
    id: 'typefaces',
    label: 'Typefaces',
    description: 'rough / clean / mono — pangrams plus mixed runs.',
  },
  {
    id: 'unicode-and-hostile-text',
    label: 'Hostile text',
    description: 'XSS payloads + unicode — proves the safety guarantee.',
  },
  {
    id: 'warnings-only',
    label: 'Warnings only',
    description: 'Unknown prop + unknown icon (resolves with warnings).',
  },
  {
    id: 'errors-unknown-tag',
    label: 'Error: unknown tag',
    description: 'A misspelled tag (did-you-mean).',
  },
];

/** Provide virtual modules sourced from the repo-root fixtures/ tree and the server's
 *  OpenAPI doc, so the playground never drifts. The template library itself is imported straight
 *  from source by engine.ts (via the aliases above), so template/normalizer edits HMR. */
function eraserSources(): Plugin {
  const VS = 'virtual:scenarios';
  const VO = 'virtual:openapi';
  const templatesDir = resolve(here, '../diagrams/src/library/templates');
  const baseCssFile = resolve(here, '../diagrams/src/library/base.style.css');
  const generateScript = resolve(here, '../diagrams/scripts/generate.mjs');

  return {
    name: 'eraser-sources',
    // New/removed fixture files must invalidate the scenario list by hand: the directory itself
    // cannot go through `addWatchFile`, because the dev server folds every added watch path into
    // the module's imports and a bare directory fails import resolution. Changes to files already
    // listed still flow through their per-file `addWatchFile` in `load`.
    configureServer(server) {
      server.watcher.add(fixturesDir);
      const onFixturesChange = (file: string) => {
        if (!file.startsWith(`${fixturesDir}${sep}`) || !file.endsWith('.json')) {
          return;
        }

        const mod = server.moduleGraph.getModuleById(`\0${VS}`);

        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }
      };
      server.watcher.on('add', onFixturesChange);
      server.watcher.on('unlink', onFixturesChange);

      // Template sources are codegen inputs, not modules: re-run generate.mjs when they change,
      // and the regenerated templates.gen.ts flows through HMR like any other source edit.
      server.watcher.add([templatesDir, baseCssFile]);
      const onTemplateChange = (file: string) => {
        if (file !== baseCssFile && !file.startsWith(`${templatesDir}${sep}`)) {
          return;
        }

        try {
          execFileSync('node', [generateScript], { stdio: 'inherit' });
        } catch {
          // Syntax errors in a half-saved template shouldn't kill the dev server; the next save
          // regenerates.
        }
      };
      server.watcher.on('change', onTemplateChange);
      server.watcher.on('add', onTemplateChange);
      server.watcher.on('unlink', onTemplateChange);
    },
    resolveId(id) {
      if (id === VS || id === VO) {
        return `\0${id}`;
      }

      return null;
    },
    async load(id) {
      if (id === `\0${VS}`) {
        const readJson = (path: string): unknown => {
          this.addWatchFile(path);

          return JSON.parse(readFileSync(path, 'utf8'));
        };

        const contract = SCENARIOS.map((s) => ({
          ...s,
          group: 'Contract fixtures',
          input: readJson(`${fixturesDir}/features/${s.id}.json`),
        }));

        // fixtures/features (probes not curated above) and fixtures/corpus (realistic diagrams) —
        // the same inputs the CLI and the golden tests render. A scenario input is always the
        // document envelope the engine takes: `{ title, elements }` and the split form pass
        // through untouched, and only the app's `{ definition: { elements } }` export wrapper is
        // lifted, so exports can be dropped in verbatim. A bare array is left alone on purpose —
        // the playground shows the engine's E_ENVELOPE answer rather than hiding it.
        const toDocument = (raw: unknown): unknown => {
          const wrapped = raw as { definition?: { elements?: unknown[] } };

          return wrapped?.definition?.elements ? { elements: wrapped.definition.elements } : raw;
        };
        const curated = new Set(SCENARIOS.map((s) => `${s.id}.json`));
        const listDir = (sub: string, group: string) =>
          readdirSync(`${fixturesDir}/${sub}`)
            .filter((f) => f.endsWith('.json') && !curated.has(f))
            .sort()
            .map((f) => ({
              id: `${sub}/${f}`,
              label: f.replace(/\.json$/, ''),
              description: `fixtures/${sub}/${f}`,
              group,
              input: toDocument(readJson(`${fixturesDir}/${sub}/${f}`)),
            }));

        return `export default ${JSON.stringify([
          ...contract,
          ...listDir('features', 'Feature fixtures'),
          ...listDir('corpus', 'Corpus'),
        ])};`;
      }

      if (id === `\0${VO}`) {
        // Parse the OpenAPI YAML to a plain object at build time (no runtime YAML parser shipped).
        const doc = parseYaml(readFileSync(`${here}../server/openapi.yaml`, 'utf8'));

        return `export default ${JSON.stringify(doc)};`;
      }

      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), eraserSources()],
  resolve: {
    alias: workspaceSourceAliases,
  },
  // The layout router reads process.env unguarded (dev warnings, debug dumps) — substituting the
  // whole object keeps those reads inert in the page, mirroring render's build-browser.mjs.
  define: {
    'process.env': '{}',
  },
  server: {
    fs: {
      // Stock woff2 files live in packages/diagrams/fonts, outside this package root.
      allow: [resolve(here, '../..')],
    },
    port: 5173,
    proxy: {
      '/validate': { target: `http://localhost:${serverPort}`, changeOrigin: true },
      '/registry': { target: `http://localhost:${serverPort}`, changeOrigin: true },
      '/health': { target: `http://localhost:${serverPort}`, changeOrigin: true },
      // The public icon bucket has no CORS config; the dev server fetches it server-side.
      '/icon-assets': {
        target: 'https://storage.googleapis.com/eraser-public-assets/canvas-icons',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/icon-assets/, ''),
      },
    },
  },
});
