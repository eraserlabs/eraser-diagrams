/**
 * A deterministic, offline icon source for the tests: the resolver takes any `IconLoader`, so the
 * suites inject this instead of the network-backed `createEraserIconLoader` and get stable SVG for
 * stable names.
 */

/** Wrap inner SVG markup in a 24×24 root. Uses `currentColor` so icons inherit text color. */
function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

const rect = '<rect x="4" y="4" width="16" height="16" rx="2"/>';
const circle = '<circle cx="12" cy="12" r="8"/>';
const cylinder = '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12a7 3 0 0 0 14 0V6"/>';
const diamond = '<path d="M12 3l9 9-9 9-9-9z"/>';
const hexagon = '<path d="M7 4h10l4 8-4 8H7l-4-8z"/>';
const triangle = '<path d="M12 4l8 16H4z"/>';

/**
 * ~24 icons across seven naming families so the resolver's family-agnostic name resolution and
 * did-you-mean have something to chew on.
 */
const stubIcons: Record<string, string> = {
  'lucide-database': svg(cylinder),
  'lucide-server': svg(rect),
  'lucide-box': svg(hexagon),
  'lucide-cloud': svg('<path d="M6 16a4 4 0 0 1 1-7.9 5 5 0 0 1 9.7 1.2A3.5 3.5 0 0 1 17 16z"/>'),
  'lucide-user': svg('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>'),
  'lucide-globe': svg(`${circle}<path d="M4 12h16M12 4c3 4 3 12 0 16M12 4c-3 4-3 12 0 16"/>`),
  'lucide-lock': svg(
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  ),
  'simple-icons-github': svg(circle),
  'simple-icons-docker': svg(rect),
  'simple-icons-kubernetes': svg(hexagon),
  'aws-ec2': svg(rect),
  'aws-s3': svg(cylinder),
  'aws-lambda': svg(triangle),
  'azure-vm': svg(rect),
  'azure-storage': svg(cylinder),
  'azure-functions': svg(triangle),
  'gcp-cloud-run': svg(circle),
  'gcp-compute-engine': svg(rect),
  'gcp-cloud-storage': svg(cylinder),
  'k8s-pod': svg(hexagon),
  'k8s-service': svg(diamond),
  'k8s-deployment': svg(rect),
  'oci-compute': svg(rect),
  'oci-storage': svg(cylinder),
};

/**
 * The pack as an icon *loader* (the shape `createResolver({ iconLoader })` takes): resolves a name
 * from the in-memory table, rejects unknown names the way a real network loader would.
 */
export async function stubIconLoader(name: string): Promise<string> {
  const icon = stubIcons[name];

  if (icon === undefined) {
    throw new Error(`stub icon pack has no icon "${name}"`);
  }

  return icon;
}
