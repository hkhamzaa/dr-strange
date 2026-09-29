// Playwright runs the real app in Chromium on the real GPU (ANGLE/D3D11 on Windows).
import { defineConfig } from '@playwright/test';

const gpuArgs = process.platform === 'win32' ? ['--use-angle=d3d11'] : [];

export default defineConfig({
  testDir: 'tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    permissions: ['camera'],
    launchOptions: {
      args: [...gpuArgs, '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--js-flags=--expose-gc', '--enable-precise-memory-info'],   // exact heap numbers for the zero-allocation test
    },
    trace: 'retain-on-failure',
  },
  webServer: { command: 'node server.mjs 5173', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 30_000 },
});
