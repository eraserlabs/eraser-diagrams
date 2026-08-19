import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DetectInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
}

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_BINARIES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

const WINDOWS_ROOTS = ['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData'];

/** Well-known install locations, in probe order. */
export function chromiumCandidates(input: DetectInput): string[] {
  switch (input.platform) {
    case 'darwin':
      return ['/Applications', join(input.home, 'Applications')].flatMap((root) =>
        MAC_APPS.map((app) => join(root, app)),
      );
    case 'linux':
      return LINUX_BINARIES;
    case 'win32':
      return WINDOWS_ROOTS.flatMap((name) => {
        const root = input.env[name];

        return root ? [join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')] : [];
      });
    default:
      return [];
  }
}

export function detectChromium(input: DetectInput): string | undefined {
  return chromiumCandidates(input).find((candidate) => input.exists(candidate));
}

export function hostDetectInput(): DetectInput {
  return { platform: process.platform, env: process.env, home: homedir(), exists: existsSync };
}
