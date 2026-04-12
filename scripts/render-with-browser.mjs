import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { getBrowserLaunchOptions, isWebgpuPage } from './playwright-launch-options.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const distDir = path.join(rootDir, 'dist');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

function createStaticServer(port) {
  const server = http.createServer((req, res) => {
    const requestPath = req.url ? req.url.split('?')[0] : '/';
    const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const filePath = path.join(distDir, relative);

    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(filePath) });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to determine listening port.'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function buildPageUrl(port, pagePath) {
  const url = new URL(`http://127.0.0.1:${port}${pagePath}`);
  url.searchParams.set('automation', '1');
  return url.toString();
}

function createCleanupController() {
  let browser = null;
  let server = null;
  let cleaned = false;

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;

    if (browser) {
      await browser.close().catch(() => {});
    }

    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      }).catch(() => {});
    }
  }

  const signalHandler = () => {
    cleanup().finally(() => {
      process.exit(130);
    });
  };

  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  return {
    setBrowser(value) {
      browser = value;
    },
    setServer(value) {
      server = value;
    },
    async cleanup() {
      process.off('SIGINT', signalHandler);
      process.off('SIGTERM', signalHandler);
      await cleanup();
    },
  };
}

export async function renderWithBrowser({
  outputPath = 'out/render/browser-output.ppm',
  width = 320,
  height = 320,
  mode = 0,
  pagePath = '/',
  yReal = 2,
  yImag = 6,
  offsetX = 1.975,
  offsetY = 6.025,
  scale,
  port = Number(process.env.MASKIT_PORT || '0'),
  maxSinkIters,
  maxDfsDepth,
  maxDfsVisits,
  returnState = false,
} = {}) {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    fail('dist/index.html がありません。先に pnpm build を実行してください。');
  }

  const cleanupController = createCleanupController();
  const { server, port: actualPort } = await createStaticServer(port);
  cleanupController.setServer(server);
  let browser;

  try {
    browser = await chromium.launch(
      getBrowserLaunchOptions({
        webgpu: isWebgpuPage(pagePath),
      }),
    );
    cleanupController.setBrowser(browser);

    const page = await browser.newPage({
      viewport: {
        width: Math.max(Number(width), 1),
        height: Math.max(Number(height), 1),
      },
    });

    await page.goto(buildPageUrl(actualPort, pagePath), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__maskitTest));

    const result = await page.evaluate(async (params) => {
      window.__maskitTest.setParams(params);
      const state = await window.__maskitTest.renderOnce();
      return {
        ppm: await window.__maskitTest.exportPpm(),
        state,
      };
    }, {
      width,
      height,
      mode,
      yReal,
      yImag,
      offsetX,
      offsetY,
      scale: scale ?? Math.min(width, height) / 16,
      maxSinkIters,
      maxDfsDepth,
      maxDfsVisits,
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, result.ppm);
    return returnState ? { outputPath, state: result.state } : outputPath;
  } finally {
    await cleanupController.cleanup();
  }
}

async function main() {
  const [
    ,
    ,
    outputPath = 'out/render/browser-output.ppm',
    width = '320',
    height = '320',
    mode = '0',
    pagePath = '/',
  ] = process.argv;

  const resultPath = await renderWithBrowser({
    outputPath,
    width: Number(width),
    height: Number(height),
    mode: Number(mode),
    pagePath,
  });

  console.log(resultPath);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
}
