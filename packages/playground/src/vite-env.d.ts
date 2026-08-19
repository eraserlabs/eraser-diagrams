/// <reference types="vite/client" />

declare module 'virtual:scenarios' {
  import type { Scenario } from './types.js';
  const scenarios: Scenario[];
  export default scenarios;
}

declare module 'virtual:openapi' {
  import type { OpenApiDoc } from './types.js';
  const doc: OpenApiDoc;
  export default doc;
}

declare module 'virtual:eraser-library' {
  import type { PageSetup } from '@eraserlabs/render/browser';
  import type { TemplateLibrary } from '@eraserlabs/resolve';
  const eraserLibrary: {
    library: TemplateLibrary;
    setup: PageSetup;
  };
  export default eraserLibrary;
}

declare module '@eraserlabs/render/browser/iife?url' {
  const url: string;
  export default url;
}
