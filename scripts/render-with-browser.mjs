import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

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

export async function renderWithBrowser({
  outputPath = 'out/render/browser-output.ppm',
  width = 320,
  height = 320,
  mode = 0,
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

  const { server, port: actualPort } = await createStaticServer(port);
  let browser;

  try {
    browser = await chromium.launch({
      channel: 'chrome',
      executablePath: process.env.BROWSER,
      headless: true,
    });

    const page = await browser.newPage({
      viewport: {
        width: Math.max(Number(width), 1),
        height: Math.max(Number(height), 1),
      },
    });

    await page.goto(`http://127.0.0.1:${actualPort}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__maskitTest));

    const result = await page.evaluate(async (params) => {
      window.__maskitTest.setParams(params);
      const state = await window.__maskitTest.renderOnce();
      return {
        ppm: window.__maskitTest.exportPpm(),
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
    if (browser) {
      await browser.close();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
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
  ] = process.argv;

  const resultPath = await renderWithBrowser({
    outputPath,
    width: Number(width),
    height: Number(height),
    mode: Number(mode),
  });

  console.log(resultPath);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
}
