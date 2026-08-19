import { describe, expect, it } from 'vitest';
import { chromiumCandidates, detectChromium, type DetectInput } from '../src/chromium.js';

function input(overrides: Partial<DetectInput>): DetectInput {
  return { platform: 'darwin', env: {}, home: '/Users/me', exists: () => false, ...overrides };
}

describe('detectChromium', () => {
  it('darwin probes /Applications then ~/Applications', () => {
    const candidates = chromiumCandidates(input({}));
    expect(candidates[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(candidates).toContain('/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium');
  });

  it('linux probes the usual binaries', () => {
    expect(chromiumCandidates(input({ platform: 'linux' }))).toContain('/usr/bin/chromium-browser');
  });

  it('win32 builds paths from the Program Files variables that are set', () => {
    const candidates = chromiumCandidates(
      input({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' } }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toContain('chrome.exe');
  });

  it('returns the first existing candidate, or undefined', () => {
    const wanted = '/Applications/Chromium.app/Contents/MacOS/Chromium';
    expect(detectChromium(input({ exists: (p) => p === wanted }))).toBe(wanted);
    expect(detectChromium(input({}))).toBeUndefined();
    expect(detectChromium(input({ platform: 'freebsd' }))).toBeUndefined();
  });
});
