# @eraserlabs/diagrams

## Introduction

`@eraserlabs/diagrams` is the batteries-included entry point of the rendering pipeline: the one package that owns everything impure. It drives Chromium (via `playwright-core`), stages and injects fonts, fetches icons, and ships the stock Eraser component library, wiring `@eraserlabs/resolve` and `@eraserlabs/render` into a single call that turns diagram JSON into PNG, measured JSON, or standalone HTML.

The pure pieces live below it: contracts in `@eraserlabs/protocol`, validation and resolution in `@eraserlabs/resolve`, in-page measurement and layout in `@eraserlabs/render` and `@eraserlabs/layout`. Use those directly when you need the pipeline without a browser; use this package when you want a picture.

## Usage

```ts
import { createRenderer } from '@eraserlabs/diagrams';

const renderer = await createRenderer({ chromiumPath: '/path/to/chromium' });

const result = await renderer.render({
  entities: [{ tag: 'Textbox', id: 't1', x: 40, y: 40, text: 'Hello' }],
  connections: [],
  outputs: { png: true, json: true },
});

if (result.ok) {
  await writeFile('diagram.png', result.png);
}

await renderer.close();
```

Chromium is caller-owned: pass a local `chromiumPath`, or a `browser` provider for caller-managed and remote browsers (`chromium.connectOverCDP(...)`). A provider owns its browser's flags — if you use `url` font faces served from localhost or a private network, launch with `--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests`, since the origin-less render page otherwise has its font fetches silently blocked by Chromium's Local Network Access checks (the `chromiumPath` path applies these flags for you). Everything else defaults to stock: the Eraser component library, the vendored fonts (Shantell Sans, Inter, JetBrains Mono — all SIL OFL 1.1, under `fonts/`), and Eraser's hosted icon catalog (which needs network access; supply `iconLoader` for offline or custom icons).

`renderer.validate` runs the same validation as `render` without touching the browser. Rendering guides live in the repo root: `GETTING_STARTED.md` for authoring and `CUSTOMIZATION.md` for bringing your own component library, palette, and fonts.
