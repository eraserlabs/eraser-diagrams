/**
 * Contact sheet over the golden baselines: every fixture's PNG on one page, changed ones first.
 *
 *   pnpm snap:sheet            write packages/diagrams/test-results/goldens-sheet.html and open it
 *   pnpm snap:sheet --no-open  write only
 *
 * "Changed" comes from the last `pnpm snap` run: Playwright leaves <name>-expected/-actual/-diff.png
 * under packages/diagrams/test-results/ for every mismatch, and those fixtures render as a triptych
 * at the top. Everything else shows its current baseline with the warning codes from its JSON golden.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const GOLDENS = join(ROOT, 'fixtures', '__goldens__');
const RESULTS = join(ROOT, 'packages', 'diagrams', 'test-results');
const OUT = join(RESULTS, 'goldens-sheet.html');
const GROUPS = ['features', 'corpus'];

interface Card {
  group: string;
  name: string;
  baseline: string;
  warnings: string[];
  changed?: { expected: string; actual: string; diff: string };
}

function baselineName(file: string): string {
  return file.replace(/-[a-z0-9]+\.png$/, '');
}

function findChanged(group: string, name: string): Card['changed'] {
  if (!existsSync(RESULTS)) {
    return undefined;
  }

  const resultDir = new RegExp(`^goldens-${group}-${name}(-retry\\d+)?$`);
  const dir = readdirSync(RESULTS).find((d) => resultDir.test(d));
  if (!dir) {
    return undefined;
  }

  const inner = join(RESULTS, dir, group);
  const has = (suffix: string) => existsSync(join(inner, `${name}-${suffix}.png`));
  if (!has('diff')) {
    return undefined;
  }

  return {
    expected: join(inner, `${name}-expected.png`),
    actual: join(inner, `${name}-actual.png`),
    diff: join(inner, `${name}-diff.png`),
  };
}

function readCards(): Card[] {
  return GROUPS.flatMap((group) => {
    const dir = join(GOLDENS, group);
    if (!existsSync(dir)) {
      return [];
    }

    return readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((png) => {
        const name = baselineName(png);
        const jsonFile = join(dir, png.replace(/\.png$/, '.json'));
        const warnings = existsSync(jsonFile)
          ? ((JSON.parse(readFileSync(jsonFile, 'utf8')) as { warnings?: string[] }).warnings ?? [])
          : [];

        return {
          group,
          name,
          baseline: join(dir, png),
          warnings,
          changed: findChanged(group, name),
        };
      });
  });
}

function href(file: string): string {
  return relative(RESULTS, file).split('\\').join('/');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderCard(card: Card): string {
  const title = `${card.group}/${card.name}`;
  const warnings =
    card.warnings.length > 0
      ? `<ul class="warnings">${card.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
      : '';

  if (card.changed) {
    return `<section class="card changed" id="${title}">
  <h2>${escapeHtml(title)} <span class="badge">changed</span></h2>
  <div class="triptych">
    <figure><figcaption>expected</figcaption><img src="${href(card.changed.expected)}" loading="lazy"></figure>
    <figure><figcaption>actual</figcaption><img src="${href(card.changed.actual)}" loading="lazy"></figure>
    <figure><figcaption>diff</figcaption><img src="${href(card.changed.diff)}" loading="lazy"></figure>
  </div>${warnings}
</section>`;
  }

  return `<section class="card" id="${title}">
  <h2>${escapeHtml(title)}</h2>
  <img src="${href(card.baseline)}" loading="lazy">${warnings}
</section>`;
}

function renderPage(cards: Card[]): string {
  const changed = cards.filter((c) => c.changed);
  const unchanged = cards.filter((c) => !c.changed);
  const nav = cards
    .map((c) => `<a href="#${c.group}/${c.name}"${c.changed ? ' class="hot"' : ''}>${c.name}</a>`)
    .join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>Goldens — ${changed.length} changed / ${cards.length}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; background: #f4f4f5; color: #18181b; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e4e4e7; padding: 10px 16px; z-index: 1; }
  header h1 { font-size: 16px; margin: 0 0 6px; }
  nav { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; max-height: 64px; overflow: auto; }
  nav a { color: #52525b; text-decoration: none; } nav a.hot { color: #dc2626; font-weight: 600; }
  main { padding: 16px; display: grid; gap: 16px; }
  .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; padding: 12px; }
  .card h2 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
  .card img { max-width: 100%; height: auto; display: block; border: 1px solid #f0f0f0; }
  .changed { border-color: #dc2626; }
  .badge { background: #dc2626; color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 4px; vertical-align: middle; }
  .triptych { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  figure { margin: 0; } figcaption { font-size: 12px; color: #71717a; margin-bottom: 4px; }
  .warnings { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: #a16207; }
</style>
<header>
  <h1>Goldens — ${changed.length} changed, ${unchanged.length} unchanged (${cards.length} fixtures)</h1>
  <nav>${nav}</nav>
</header>
<main>
${[...changed, ...unchanged].map(renderCard).join('\n')}
</main>
`;
}

const cards = readCards();
mkdirSync(RESULTS, { recursive: true });
writeFileSync(OUT, renderPage(cards));
console.info(`${OUT}  (${cards.filter((c) => c.changed).length} changed / ${cards.length})`);

if (!process.argv.includes('--no-open')) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFileSync(opener, [OUT], { stdio: 'ignore' });
}
