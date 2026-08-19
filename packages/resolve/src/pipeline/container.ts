/**
 * Tag `x-is-container` fills a missing `isContainer`. A present boolean is the entity's
 * container-ness — a Shape may opt in, a Group may opt out.
 */
export function entityIsContainer(
  element: Record<string, unknown>,
  tag: string,
  containerTags: ReadonlySet<string>,
): boolean {
  if (element['isContainer'] === false) {
    return false;
  }

  if (element['isContainer'] === true) {
    return true;
  }

  return containerTags.has(tag);
}
