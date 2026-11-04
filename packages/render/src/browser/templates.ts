import type { PageSetup } from './types.js';

/** The same host-scoped CSS for the page runner and hosts that render individual elements. */
export function templateRegistry(config: PageSetup): {
  templates: Record<string, string>;
  templateCss: Record<string, string>;
  css: string;
} {
  const templates: Record<string, string> = {};
  const templateCss: Record<string, string> = {};
  for (const [name, template] of Object.entries(config.templates)) {
    templates[name] = template.html;
    templateCss[name] =
      template.css.trim() === ''
        ? ''
        : `@scope([data-mdp-tag="${name}"]) to ([data-mdp-tag]){${template.css}}`;
  }
  return { templates, templateCss, css: config.baseCss + Object.values(templateCss).join('') };
}
