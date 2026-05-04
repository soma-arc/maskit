function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

function parseListEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getBrowserLaunchOptions({ webgpu = false } = {}) {
  const args = [...parseListEnv('MASKIT_BROWSER_ARGS')];

  if (webgpu) {
    args.push(
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--disable-vulkan-surface',
    );
  }

  return {
    channel: process.env.MASKIT_BROWSER_CHANNEL || 'chrome',
    executablePath: process.env.BROWSER,
    headless: parseBooleanEnv('MASKIT_BROWSER_HEADLESS', true),
    args: [...new Set(args)],
  };
}

export function isWebgpuPage(pagePath) {
  return pagePath !== '/webgl.html';
}
