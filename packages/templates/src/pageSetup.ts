import type { PageSetup } from '@eraserlabs/render/browser';
import type { TemplateLibrary } from '@eraserlabs/resolve';
import { WATERCOLOR_MASTER } from './watercolorTexture.js';

/**
 * Translate one prepared template library into the renderer's page-lifetime registry: markup and
 * CSS per template name, plus the shared base CSS and the watercolor master. Element kind is not
 * part of it — the resolver classifies from `x-schema-kind` and hands the render stage two already
 * split lists, so the page never needs a kind table.
 */
export function buildRenderPageSetup(library: TemplateLibrary): PageSetup {
  return {
    templates: Object.fromEntries(
      library.templates.map((template) => [
        template.name,
        { html: template.html, css: template.css },
      ]),
    ),
    baseCss: library.baseCss,
    washMaster: WATERCOLOR_MASTER,
  };
}
