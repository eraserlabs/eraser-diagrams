import { chromium } from 'playwright-core';

/** Executable installed by the Playwright development test setup. */
export const CHROMIUM_PATH = chromium.executablePath();

/**
 * Origin-less pages (`about:blank`, `data:`) fetching `http://127.0.0.1` fonts trip Chromium
 * Local Network Access checks; headless cannot grant that permission.
 */
export const CHROMIUM_ARGS = [
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
];
