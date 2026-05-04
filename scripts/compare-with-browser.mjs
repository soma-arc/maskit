import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildDiffPpm,
  buildMaskP1,
  compareMasks,
  compareNetpbmFiles,
  fail,
  readAsciiNetpbm,
  toBinaryMask,
} from './compare-images.mjs';
import { refineUnknownMask } from './bq-cpu.mjs';
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

function shouldApplyCpuRefinement(pagePath) {
  return pagePath !== '/webgl.html' && process.env.MASKIT_CPU_REFINE !== '0';
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
    includeAllUnknownPixels: shouldApplyCpuRefinement(pagePath),
    unknownSampleLimit,
    pagePath,
    returnState: true,
  });
  let summary;
  let comparedOutputPath = rendered.outputPath;
  let cpuRefinement = null;

  if (
    shouldApplyCpuRefinement(pagePath) &&
    rendered.allUnknownPixels &&
    rendered.allUnknownPixels.returnedCount > 0
  ) {
    const reference = readAsciiNetpbm(referencePath);
    const candidate = readAsciiNetpbm(rendered.outputPath);
    const referenceMask = toBinaryMask(reference);
    const candidateMask = toBinaryMask(candidate);
    const refined = refineUnknownMask(rendered.state, candidateMask, rendered.allUnknownPixels.indices, {
      maxSinkIters: 1_000_000,
      maxDepth: 995,
    });

    comparedOutputPath = path.join(compareDir, 'cpu-refined.pbm');
    ensureDir(compareDir);
    fs.writeFileSync(comparedOutputPath, buildMaskP1(reference.width, reference.height, refined.refinedMask));

    const compared = compareMasks(referenceMask, refined.refinedMask);
    const summaryPath = path.join(compareDir, 'summary.json');
    const diffPath = path.join(compareDir, 'diff.ppm');
    fs.writeFileSync(summaryPath, `${JSON.stringify(compared, null, 2)}\n`);
    fs.writeFileSync(diffPath, buildDiffPpm(reference.width, reference.height, referenceMask, refined.refinedMask));
    summary = { summaryPath, diffPath, ...compared };
    cpuRefinement = {
      applied: true,
      refinedOutputPath: comparedOutputPath,
      unresolvedInputCount: rendered.allUnknownPixels.unknownCount,
      refinedPixelCount: refined.resolvedCount,
      resolvedTrue: refined.resolvedTrue,
      resolvedFalse: refined.resolvedFalse,
    };
  } else {
    summary = compareNetpbmFiles(referencePath, rendered.outputPath, compareDir);
    cpuRefinement = {
      applied: false,
      refinedOutputPath: null,
      unresolvedInputCount: rendered.allUnknownPixels?.unknownCount ?? 0,
      refinedPixelCount: 0,
      resolvedTrue: 0,
      resolvedFalse: 0,
    };
  }
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
    comparedOutputPath,
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
    cpuRefinement,
    artifacts: {
      summaryPath: summary.summaryPath,
      diffPath: summary.diffPath,
      statsPath: statsPayload ? statsPath : null,
      unknownSamplePath: rendered.unknownSample ? unknownSamplePath : null,
      comparedOutputPath,
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
    cpuRefinementApplied: historyEntry.cpuRefinement?.applied ?? false,
    refinedPixelCount: historyEntry.cpuRefinement?.refinedPixelCount ?? 0,
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
        cpuRefinement,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
