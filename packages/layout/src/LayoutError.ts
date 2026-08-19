export class LayoutError extends Error {}

export class MissingEntityError extends LayoutError {
  constructor(msg: string, id: string) {
    super(`${msg}: ${id}`);
  }
}

export class LayoutDuplicateError extends LayoutError {
  constructor(msg: string, id: string) {
    super(`${msg}: ${id}`);
  }
}
