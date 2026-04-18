import fs from 'node:fs';
import path from 'node:path';
import { compareNetpbmFiles, fail } from './compare-images.mjs';
import { renderWithBrowser } from './render-with-browser.mjs';

function parseOptionalNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const referencePath = args[0] || 'img.ppm';
  const outputPath = args[1] || 'out/render/browser-output.ppm';
  const compareDir = args[2] || 'out/compare/browser-run';
  const mode = parseOptionalNumber(args[3], 5);
  const width = parseOptionalNumber(args[4], 320);
  const height = parseOptionalNumber(args[5], 320);
  const maxSinkIters = parseOptionalNumber(args[6], undefined);
  const maxDfsDepth = parseOptionalNumber(args[7], undefined);
  const maxDfsVisits = parseOptionalNumber(args[8], undefined);
  const pagePath = args[9] || '/';
  const unknownSampleLimit = parseOptionalNumber(args[10], 64);

  const rendered = await renderWithBrowser({
    outputPath,
    width,
    height,
    mode,
    maxSinkIters,
    maxDfsDepth,
    maxDfsVisits,
    includeDiagnostics: true,
    unknownSampleLimit,
    pagePath,
    returnState: true,
  });
  const summary = compareNetpbmFiles(referencePath, rendered.outputPath, compareDir);
  const statsPath = path.join(compareDir, 'stats.json');
  const unknownSamplePath = path.join(compareDir, 'unknown-sample.json');
  const statsPayload = rendered.classificationStats
    ? {
        ...rendered.classificationStats,
        renderState: rendered.state,
      }
    : null;
  if (statsPayload) {
    fs.writeFileSync(statsPath, `${JSON.stringify(statsPayload, null, 2)}\n`);
  }
  if (rendered.unknownSample) {
    fs.writeFileSync(unknownSamplePath, `${JSON.stringify(rendered.unknownSample, null, 2)}\n`);
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        renderState: rendered.state,
        statsPath: statsPayload ? statsPath : null,
        unknownSamplePath: rendered.unknownSample ? unknownSamplePath : null,
        classificationStats: rendered.classificationStats,
        unknownSample: rendered.unknownSample,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
