# @eraserlabs/diagrams-cli

## Introduction

`@eraserlabs/diagrams-cli` is the command-line interface for [Eraser Diagrams](../../README.md). It renders diagram JSON to PNG or HTML and validates documents without a browser, using [`@eraserlabs/diagrams`](../diagrams/).

## Usage

```bash
npm install -D @eraserlabs/diagrams-cli
npx eraser-diagrams render diagram.json -o diagram.png
```

Requires Node.js 22.12+ and a Chromium-family browser on the machine (not bundled).

```text
eraser-diagrams render <input...>     Render diagram JSON to PNG or HTML (needs Chromium)
eraser-diagrams validate <input...>   Validate diagram JSON without a browser
eraser-diagrams registry              Print the tag registry as JSON
eraser-diagrams schema <tag>          Print the JSON Schema of one tag
eraser-diagrams init                  Write eraser-diagrams.config.json in the current directory
```

`<input>` is a file path or `-` for stdin. Several inputs share one warm browser. Accepted documents are `{ "elements": [...] }` or the split `{ "entities": [...], "connections": [...] }`. A bare JSON array fails with `E_ENVELOPE`. A `{ "definition": { "elements": [...] } }` wrapper is lifted with a note on stderr.

### render options

| Flag | Default | Effect |
| --- | --- | --- |
| `-o, --out <path>` | `<input>.<format>` in the output directory (`diagram.<format>` for stdin) | Output file for a single input. `-o -` writes the bytes to stdout. |
| `--out-dir <dir>` | current directory | Where outputs go; created if missing. |
| `-f, --format png\|html` | `png` | Output format. HTML references each font's source (`inline: true` embeds file faces). |
| `--scale <n>` | `1` | PNG pixel density (`deviceScaleFactor`; `2` for retina). Ignored for HTML. |
| `--pages <n>` | `1` | Warm Chromium page pool; more pages render more inputs concurrently. |
| `--chromium-path <path>` | see below | Chromium executable. |
| `--fonts <path>` | stock fonts | Fonts config JSON file. |
| `--icon-base-url <url>` | Eraser's public catalog | Icon host: `<url>/<name>.svg`. |
| `--icon-cache-dir <dir>` | none | On-disk icon cache. |
| `--unknown-icon placeholder\|error` | `placeholder` | Unknown icon names: placeholder glyph + warning, or a hard error. |
| `--json` | off | Machine-readable report on stdout (nothing else goes to stdout). |
| `--fail-on-warning` | off | Exit 1 when any warning is reported (including degraded fonts). |
| `-q, --quiet` | off | No per-input status lines; failures still print. |
| `--debug` | off | Stage timings and config/Chromium provenance on stderr. |

`validate` accepts `--json`, `--fail-on-warning`, `--quiet`, `--debug`.

### Global options

| Flag | Effect |
| --- | --- |
| `-c, --config <path>` | Config file to use. |
| `--no-config` | Ignore config files. |
| `--print-config` | Print the effective configuration (after merging) and exit. |
| `-h, --help`, `-v, --version` | Help / versions. |

## Chromium

Precedence: `--chromium-path` > `CHROMIUM_PATH` > `chromiumPath` in the config file > auto-detect. Auto-detect probes the usual Chrome and Chromium install locations and reports which one it picked. `eraser-diagrams init` writes the detected path into a config file so it stays pinned.

## Configuration file

`eraser-diagrams.config.json` is found by walking up from the current directory (stopping at the first directory that contains `.git`), or given with `--config` or `ERASER_DIAGRAMS_CONFIG`. Precedence is **flag > environment > config file > default**. Relative paths in the file resolve against the file's own directory. Unknown keys are rejected.

```json
{
  "chromiumPath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "format": "png",
  "outDir": "./diagrams",
  "deviceScaleFactor": 2,
  "pages": 2,
  "icons": {
    "baseUrl": "https://storage.googleapis.com/eraser-public-assets/canvas-icons/",
    "cacheDir": "./.eraser/icons",
    "timeoutMs": 5000,
    "cacheTtlMs": 86400000,
    "onUnknown": "placeholder"
  },
  "fonts": "./fonts.json",
  "library": "./my-library.mjs",
  "overrides": "./my-overrides.mjs",
  "failOnWarning": false
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `chromiumPath` | string | Chromium executable. |
| `format` | `"png"` \| `"html"` | Default `--format`. |
| `outDir` | string | Default `--out-dir`. |
| `deviceScaleFactor` | number | Default `--scale`. |
| `pages` | number | Default `--pages`. |
| `icons.baseUrl`, `icons.cacheDir`, `icons.timeoutMs`, `icons.cacheTtlMs` |  | Icon loader settings (`createEraserIconLoader`). |
| `icons.onUnknown` | `"placeholder"` \| `"error"` | Unknown icon policy. |
| `fonts` | object or string | A `FontsConfig` object, or the path to a JSON file holding one. `path` / `cachePath` inside it resolve against the file that declares them. |
| `library` | string | ES module path exporting `library` (an `AuthoredLibrary`) and optionally `normalizers`. Replaces the stock library; see [CUSTOMIZATION.md](../../CUSTOMIZATION.md). |
| `overrides` | string | ES module path exporting `overrides` (`{ templates: TemplateFile[] }`): component overrides merged over the library by name. |
| `failOnWarning` | boolean | Default `--fail-on-warning`. |

Everything except `--format` and the output path is fixed when the browser boots, so it applies to the whole batch.

## Output and exit codes

Status goes to stderr, one line per input, followed by its issues:

```text
ok    diagram.json  → out/diagram.png  412 ms  1 warning
  warning W_UNKNOWN_ICON /elements/1/icon (Icon#api) — Unknown icon "nodejs"; using a placeholder glyph.
FAIL  other.json  E_UNKNOWN_TAG
  error   E_UNKNOWN_TAG /elements/0 (Shpe) — Unknown tag "Shpe". Did you mean "Shape"?
```

`--json` prints one report on stdout instead:

```json
{
  "ok": false,
  "degradedFonts": [],
  "results": [
    {
      "input": "diagram.json",
      "out": "out/diagram.png",
      "ok": true,
      "errors": [],
      "warnings": [],
      "ms": 412
    },
    {
      "input": "other.json",
      "ok": false,
      "errors": [
        {
          "code": "E_UNKNOWN_TAG",
          "severity": "error",
          "path": "/elements/0",
          "message": "Unknown tag \"Shpe\".",
          "suggestion": "Shape"
        }
      ],
      "warnings": []
    }
  ]
}
```

| Exit code | Meaning |
| --- | --- |
| `0` | Every input succeeded (warnings allowed unless `--fail-on-warning`). |
| `1` | At least one input failed: unreadable file, invalid JSON, validation errors, or a failed render. |
| `2` | The invocation itself failed: bad flag, bad config file, no Chromium, custom library rejected. |

`Ctrl-C` closes Chromium before exiting.
