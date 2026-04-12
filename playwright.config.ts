import { defineConfig } from '@playwright/test';
import { getBrowserLaunchOptions } from './scripts/playwright-launch-options.mjs';

const launch = getBrowserLaunchOptions({ webgpu: true });

export default defineConfig({
  use: {
    browserName: 'chromium',
    channel: launch.channel,
    headless: launch.headless,
    launchOptions: {
      executablePath: launch.executablePath,
      args: launch.args,
    },
    viewport: {
      width: 640,
      height: 640,
    },
  },
});
