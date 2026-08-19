/** Invocation-level failure (bad flag, bad config, no Chromium): message on stderr, exit 2. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
