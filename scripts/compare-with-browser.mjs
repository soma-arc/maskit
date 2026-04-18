import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareNetpbmFiles, fail } from './compare-images.mjs';
import { renderWithBrowser } from './render-with-browser.mjs';

function parseOptionalNumber(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function buildRunId() {
  return new Date().toISOString().replaceAll(':', '-');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonFile(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function appendJsonLine(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
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
  const historyDir = path.join('out', 'history');
  const runId = buildRunId();
  const compareLabel = path.basename(path.resolve(compareDir));
  const historyPath = path.join(historyDir, `${runId}-${compareLabel}.json`);
  const latestPath = path.join(historyDir, `latest-${compareLabel}.json`);
  const historyIndexPath = path.join(historyDir, 'index.jsonl');
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

  const historyEntry = {
    runId,
    timestamp: new Date().toISOString(),
    gitSha: getGitSha(),
    referencePath,
    outputPath: rendered.outputPath,
    compareDir,
    pagePath,
    params: {
      mode,
      width,
      height,
      maxSinkIters,
      maxDfsDepth,
      maxDfsVisits,
      unknownSampleLimit,
    },
    summary,
    renderState: rendered.state,
    classificationStats: rendered.classificationStats,
    unknownSample: rendered.unknownSample,
    artifacts: {
      summaryPath: summary.summaryPath,
      diffPath: summary.diffPath,
      statsPath: statsPayload ? statsPath : null,
      unknownSamplePath: rendered.unknownSample ? unknownSamplePath : null,
    },
  };
  writeJsonFile(historyPath, historyEntry);
  writeJsonFile(latestPath, historyEntry);
  appendJsonLine(historyIndexPath, {
    runId: historyEntry.runId,
    timestamp: historyEntry.timestamp,
    gitSha: historyEntry.gitSha,
    compareDir: historyEntry.compareDir,
    pagePath: historyEntry.pagePath,
    params: historyEntry.params,
    mismatchRatio: historyEntry.summary.mismatchRatio,
    mismatches: historyEntry.summary.mismatches,
    falsePositive: historyEntry.summary.falsePositive,
    falseNegative: historyEntry.summary.falseNegative,
    statsPath: historyEntry.artifacts.statsPath,
    unknownSamplePath: historyEntry.artifacts.unknownSamplePath,
    historyPath,
  });

  console.log(
    JSON.stringify(
      {
        ...summary,
        historyPath,
        latestHistoryPath: latestPath,
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
