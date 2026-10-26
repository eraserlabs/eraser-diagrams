import type { PageSetup } from './types.js';

/** The same host-scoped CSS for the page runner and hosts that render individual elements. */
export function templateRegistry(config: PageSetup): {
  templates: Record<string, string>;
  css: string;
} {
  const templates: Record<string, string> = {};
  const scoped: string[] = [];
  for (const [name, template] of Object.entries(config.templates)) {
    templates[name] = template.html;
    if (template.css.trim() !== '') {
      scoped.push(`@scope([data-mdp-tag="${name}"]) to ([data-mdp-tag]){${template.css}}`);
    }
  }
  return { templates, css: config.baseCss + scoped.join('') };
}
