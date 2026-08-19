import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
// Suite-owned document (the connections fixture retired from fixtures/features): written to a
// temp dir at module load, basename preserved because assertions read the derived output name.
const FIXTURE = join(mkdtempSync(join(tmpdir(), 'eraser-cli-fixture-')), 'connections.json');
writeFileSync(
  FIXTURE,
  JSON.stringify({
    elements: [
      { tag: 'Shape', id: 'a', x: 0, y: 0, width: 100, height: 50, texts: [{ text: 'A' }] },
      { tag: 'Shape', id: 'b', x: 300, y: 0, width: 100, height: 50, texts: [{ text: 'B' }] },
      {
        tag: 'Relationship',
        id: 'r1',
        x: 0,
        y: 0,
        from: 'a',
        to: 'b',
        points: [
          { x: 100, y: 25 },
          { x: 300, y: 25 },
        ],
        label: 'links to',
      },
      {
        tag: 'Relationship',
        id: 'r2',
        x: 0,
        y: 0,
        from: 'a',
        to: 'a',
        points: [
          { x: 10, y: 0 },
          { x: 10, y: -20 },
          { x: 40, y: -20 },
        ],
        label: 'self',
      },
    ],
  }),
);
const WRAPPED_FIXTURE = join(
  HERE,
  '..',
  '..',
  '..',
  'fixtures',
  'features',
  'elements-badges.json',
);
/** Executable installed by the Playwright development test setup (may be absent). */
const PLAYWRIGHT_CHROMIUM = chromium.executablePath();
const CHROMIUM_PATH = existsSync(PLAYWRIGHT_CHROMIUM) ? PLAYWRIGHT_CHROMIUM : null;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

interface RunOptions {
  input?: string;
  cwd?: string;
  chromiumPath?: string | null;
  encoding?: 'utf8' | 'buffer';
}

function run(args: string[], options: RunOptions = {}): SpawnSyncReturns<string> {
  const env = { ...process.env };
  const chromiumPath = options.chromiumPath === undefined ? CHROMIUM_PATH : options.chromiumPath;
  env.CHROMIUM_PATH = chromiumPath ?? undefined;
  env.ERASER_DIAGRAMS_CONFIG = undefined;
  // Fresh cwd per call: no config discovery from the repo, output lands in the temp dir.
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'eraser-cli-'));

  return spawnSync('node', [CLI, ...args], {
    cwd,
    env,
    encoding: options.encoding ?? 'utf8',
    ...(options.input !== undefined ? { input: options.input } : {}),
  }) as SpawnSyncReturns<string>;
}

function runBuffer(args: string[], options: RunOptions = {}): SpawnSyncReturns<Buffer> {
  return run(args, { ...options, encoding: 'buffer' }) as unknown as SpawnSyncReturns<Buffer>;
}

// Chromium boots inside several of these; give them room.
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!existsSync(CLI))(
  'cli (runs the built dist/cli.js; build the package first)',
  () => {
    it('prints usage without a command and per-command help', () => {
      expect(run([]).stdout).toContain('Usage: eraser-diagrams <command>');
      const help = run(['render', '--help']);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('--out-dir');
    });

    it('--version names both packages', () => {
      const r = run(['--version']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(
        /^@eraserlabs\/diagrams-cli \d+\.\d+\.\d+ \(@eraserlabs\/diagrams \d+\.\d+\.\d+, node v/,
      );
    });

    it('unknown command / unknown flag → exit 2', () => {
      expect(run(['paint']).status).toBe(2);
      const r = run(['validate', FIXTURE, '--scale', '2']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Unknown option '--scale'");
    });

    it('validate: exit 0, human status line on stderr, nothing on stdout', () => {
      const r = run(['validate', FIXTURE]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^ok {4}.*connections\.json/);
    });

    it('validate --json: report envelope on stdout, exit 1 for bad input on stdin', () => {
      const r = run(['validate', '-', '--json'], {
        input: JSON.stringify({ elements: [{ tag: 'Nope', id: 'x', x: 0, y: 0 }] }),
      });
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.ok).toBe(false);
      expect(report.results[0].input).toBe('-');
      expect(report.results[0].errors[0].code).toBe('E_UNKNOWN_TAG');
    });

    it('validate: { title, elements } exports need no unwrapping', () => {
      const r = run(['validate', WRAPPED_FIXTURE]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toContain('unwrapped');
    });

    it('validate: accepts the split { entities, connections } form', () => {
      const split = run(['validate', '-'], {
        input: JSON.stringify({
          entities: [
            { tag: 'Shape', id: 'a', x: 0, y: 0 },
            { tag: 'Shape', id: 'b', x: 200, y: 0 },
          ],
          connections: [{ tag: 'Relationship', from: 'a', to: 'b' }],
        }),
      });
      expect(split.status, split.stderr).toBe(0);
    });

    it('validate: a bare-array file is an envelope error, not a shorthand', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'eraser-cli-'));
      const bare = join(cwd, 'bare.json');
      writeFileSync(bare, JSON.stringify([{ tag: 'Shape', id: 'a', x: 0, y: 0 }]));

      const r = run(['validate', bare, '--json'], { cwd });
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.ok).toBe(false);
      expect(report.results[0].errors[0].code).toBe('E_ENVELOPE');
      expect(report.results[0].errors[0].message).toBe(
        'Input must be an object: wrap the array in { "elements": [...] }.',
      );

      // The human path teaches the same thing on stderr and exits 1.
      const human = run(['validate', bare], { cwd });
      expect(human.status).toBe(1);
      expect(human.stderr).toContain('E_ENVELOPE');
      expect(human.stderr).toContain('wrap the array in { "elements": [...] }');
    });

    it('validate: a bare array on stdin fails the same way', () => {
      const r = run(['validate', '-', '--json'], {
        input: JSON.stringify([{ tag: 'Shape', id: 'a', x: 0, y: 0 }]),
      });
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.results[0].errors[0].code).toBe('E_ENVELOPE');
      expect(report.results[0].errors[0].message).toBe(
        'Input must be an object: wrap the array in { "elements": [...] }.',
      );
    });

    it('validate: a connection inside "entities" is a kind mismatch', () => {
      const r = run(['validate', '-', '--json'], {
        input: JSON.stringify({
          entities: [
            { tag: 'Shape', id: 'a', x: 0, y: 0 },
            { tag: 'Shape', id: 'b', x: 200, y: 0 },
            { tag: 'Relationship', from: 'a', to: 'b' },
          ],
          connections: [],
        }),
      });
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.results[0].errors[0].code).toBe('E_KIND_MISMATCH');
      expect(report.results[0].errors[0].path).toBe('/entities/2');
    });

    it('validate: "entities" without "connections" is an envelope error', () => {
      const r = run(['validate', '-', '--json'], {
        input: JSON.stringify({ entities: [{ tag: 'Shape', id: 'a', x: 0, y: 0 }] }),
      });
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.results[0].errors[0].code).toBe('E_ENVELOPE');
      expect(report.results[0].errors[0].message).toContain('connections');
    });

    it('validate: unreadable input is a per-input failure (exit 1), not a crash', () => {
      const r = run(['validate', '/nowhere/missing.json', '--json']);
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).results[0].errors[0].code).toBe('E_BAD_JSON');
    });

    it('registry and schema print JSON; unknown tag exits 2 with the tag list', () => {
      const registry = JSON.parse(run(['registry']).stdout);
      expect(registry.tags.map((t: { tag: string }) => t.tag)).toContain('Shape');
      const schema = run(['schema', 'Shape']);
      expect(schema.status).toBe(0);
      expect(JSON.parse(schema.stdout).properties.tag.const).toBe('Shape');
      const unknown = run(['schema', 'Nope']);
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toContain('Known tags:');
    });

    it('config file: discovered from cwd, unknown key → exit 2, --print-config shows the merge', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'eraser-cli-cfg-'));
      writeFileSync(
        join(cwd, 'eraser-diagrams.config.json'),
        JSON.stringify({ pages: 3, format: 'html' }),
      );
      const printed = run(['render', 'x.json', '--print-config', '--format', 'png'], { cwd });
      expect(printed.status, printed.stderr).toBe(0);
      const config = JSON.parse(printed.stdout);
      expect(config).toMatchObject({ pages: 3, format: 'png' });
      expect(config.configPath).toContain('eraser-diagrams.config.json');

      writeFileSync(join(cwd, 'eraser-diagrams.config.json'), JSON.stringify({ chromium: '/x' }));
      const bad = run(['validate', FIXTURE], { cwd });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('Unknown config key "chromium"');
    });

    it('init writes a config once, --force overwrites', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'eraser-cli-init-'));
      const first = run(['init', '--chromium-path', '/opt/chrome'], { cwd });
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(cwd, 'eraser-diagrams.config.json'), 'utf8'))).toEqual({
        chromiumPath: '/opt/chrome',
      });
      expect(run(['init'], { cwd }).status).toBe(2);
      expect(run(['init', '--force', '--chromium-path', '/opt/other'], { cwd }).status).toBe(0);
    });

    it('render: --json and "-o -" are mutually exclusive; --out needs one input', () => {
      expect(run(['render', FIXTURE, '-o', '-', '--json']).status).toBe(2);
      expect(run(['render', FIXTURE, FIXTURE, '-o', 'x.png']).status).toBe(2);
    });

    it('render: no Chromium anywhere → exit 2 with guidance (probes a bogus HOME)', () => {
      const r = spawnSync('node', [CLI, 'render', FIXTURE], {
        encoding: 'utf8',
        cwd: mkdtempSync(join(tmpdir(), 'eraser-cli-')),
        env: {
          ...process.env,
          CHROMIUM_PATH: '',
          ERASER_DIAGRAMS_CONFIG: '',
          HOME: '/nonexistent',
          PATH: process.env.PATH ?? '',
        },
      });
      // On a machine with Chrome under /Applications or /usr/bin the auto-detect will succeed instead.
      if (r.status === 2) {
        expect(r.stderr).toContain('Rendering requires Chromium');
      } else {
        expect(r.stderr).toContain('auto-detected');
      }
    });

    describe.skipIf(!CHROMIUM_PATH)('with Chromium', () => {
      it('render: writes a PNG next to the input name in cwd, status line on stderr', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'eraser-cli-'));
        const r = run(['render', FIXTURE], { cwd });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).toMatch(/^ok {4}.*connections\.json {2}→ connections\.png {2}\d+ ms/);
        expect(readFileSync(join(cwd, 'connections.png')).subarray(0, 4)).toEqual(PNG_MAGIC);
      });

      it('render: -o path and --format html', () => {
        const out = join(mkdtempSync(join(tmpdir(), 'eraser-cli-')), 'nested', 'out.html');
        const r = run(['render', FIXTURE, '--format', 'html', '-o', out]);
        expect(r.status, r.stderr).toBe(0);
        const html = readFileSync(out, 'utf8');
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('id="eraser-scene"');
      });

      it('render: "-o -" streams PNG bytes to stdout', () => {
        const r = runBuffer(['render', FIXTURE, '-o', '-']);
        expect(r.status, r.stderr.toString()).toBe(0);
        expect(r.stdout.subarray(0, 4)).toEqual(PNG_MAGIC);
      });

      it('render: batch into --out-dir with --json report; one bad input does not stop the rest', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'eraser-cli-'));
        const bad = join(cwd, 'bad.json');
        writeFileSync(bad, JSON.stringify({ elements: [{ tag: 'Nope', id: 'x' }] }));
        const r = run(['render', FIXTURE, bad, '--out-dir', 'out', '--json'], { cwd });
        expect(r.status).toBe(1);
        const report = JSON.parse(r.stdout);
        expect(report.ok).toBe(false);
        expect(report.results).toHaveLength(2);
        expect(report.results[0]).toMatchObject({ ok: true, out: join('out', 'connections.png') });
        expect(report.results[1].errors[0].code).toBe('E_UNKNOWN_TAG');
        expect(readFileSync(join(cwd, 'out', 'connections.png')).subarray(0, 4)).toEqual(PNG_MAGIC);
      });

      it('render: --debug prints timings; --fail-on-warning turns warnings into exit 1', () => {
        const debug = run([
          'render',
          FIXTURE,
          '--debug',
          '-o',
          join(mkdtempSync(join(tmpdir(), 'e-')), 'a.png'),
        ]);
        expect(debug.status, debug.stderr).toBe(0);
        expect(debug.stderr).toContain('boot (chromium + pages + fonts)');
        expect(debug.stderr).toContain('debug chromium:');

        const cwd = mkdtempSync(join(tmpdir(), 'eraser-cli-'));
        const warn = join(cwd, 'warn.json');
        writeFileSync(
          warn,
          JSON.stringify({
            elements: [{ tag: 'Shape', id: 'a', x: 0, y: 0, width: 100, height: 50, bogus: 1 }],
          }),
        );
        const r = run(['render', warn, '--fail-on-warning'], { cwd });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('W_UNKNOWN_PROP');
      });
    });
  },
);
