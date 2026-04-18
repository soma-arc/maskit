import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function fail(message) {
  console.error(message);
  process.exit(1);
}

export function readAsciiNetpbm(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const tokens = raw.replace(/#[^\n\r]*/g, ' ').trim().split(/\s+/);

  if (tokens.length < 3) {
    fail(`Invalid Netpbm file: ${filePath}`);
  }

  let index = 0;
  const magic = tokens[index++];
  if (!['P1', 'P2', 'P3'].includes(magic)) {
    fail(`Unsupported Netpbm format in ${filePath}: ${magic}. Expected P1, P2, or P3.`);
  }

  const width = Number(tokens[index++]);
  const height = Number(tokens[index++]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail(`Invalid image size in ${filePath}.`);
  }

  let maxValue = 1;
  if (magic !== 'P1') {
    maxValue = Number(tokens[index++]);
    if (!Number.isInteger(maxValue) || maxValue <= 0) {
      fail(`Invalid max value in ${filePath}.`);
    }
  }

  const channels = magic === 'P3' ? 3 : 1;
  const expectedSamples = width * height * channels;
  const sampleTokens = tokens.slice(index);
  if (sampleTokens.length !== expectedSamples) {
    fail(
      `Unexpected sample count in ${filePath}. Expected ${expectedSamples}, got ${sampleTokens.length}.`,
    );
  }

  const samples = new Uint16Array(expectedSamples);
  for (let i = 0; i < expectedSamples; i += 1) {
    const value = Number(sampleTokens[i]);
    if (!Number.isFinite(value) || value < 0 || value > maxValue) {
      fail(`Invalid sample value at index ${i} in ${filePath}.`);
    }
    samples[i] = value;
  }

  return { magic, width, height, maxValue, samples };
}

export function toBinaryMask(image) {
  const { magic, width, height, maxValue, samples } = image;
  const count = width * height;
  const mask = new Uint8Array(count);

  if (magic === 'P1') {
    for (let i = 0; i < count; i += 1) {
      mask[i] = samples[i] !== 0 ? 1 : 0;
    }
    return mask;
  }

  if (magic === 'P2') {
    const threshold = maxValue / 2;
    for (let i = 0; i < count; i += 1) {
      mask[i] = samples[i] > threshold ? 1 : 0;
    }
    return mask;
  }

  const threshold = maxValue / 2;
  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    const luminance =
      0.2126 * samples[base] + 0.7152 * samples[base + 1] + 0.0722 * samples[base + 2];
    mask[i] = luminance <= threshold ? 1 : 0;
  }
  return mask;
}

export function compareMasks(referenceMask, candidateMask) {
  let matches = 0;
  let mismatches = 0;
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (let i = 0; i < referenceMask.length; i += 1) {
    const reference = referenceMask[i];
    const candidate = candidateMask[i];

    if (reference === candidate) {
      matches += 1;
      if (reference === 1) {
        truePositive += 1;
      } else {
        trueNegative += 1;
      }
      continue;
    }

    mismatches += 1;
    if (candidate === 1) {
      falsePositive += 1;
    } else {
      falseNegative += 1;
    }
  }

  const total = referenceMask.length;
  const union = truePositive + falsePositive + falseNegative;
  const predictedPositive = truePositive + falsePositive;
  const actualPositive = truePositive + falseNegative;

  return {
    totalPixels: total,
    matches,
    mismatches,
    mismatchRatio: total === 0 ? 0 : mismatches / total,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    iou: union === 0 ? 1 : truePositive / union,
    dice: predictedPositive + actualPositive === 0 ? 1 : (2 * truePositive) / (predictedPositive + actualPositive),
  };
}

export function buildDiffPpm(width, height, referenceMask, candidateMask) {
  const lines = ['P3', `${width} ${height}`, '255'];

  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const reference = referenceMask[index];
      const candidate = candidateMask[index];

      if (reference === 1 && candidate === 1) {
        row.push('255 255 255');
      } else if (reference === 0 && candidate === 0) {
        row.push('0 0 0');
      } else if (reference === 0 && candidate === 1) {
        row.push('255 64 64');
      } else {
        row.push('64 160 255');
      }
    }
    lines.push(row.join(' '));
  }

  return `${lines.join('\n')}\n`;
}

export function buildMaskP1(width, height, mask) {
  const lines = ['P1', `${width} ${height}`];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      row.push(String(mask[y * width + x]));
    }
    lines.push(row.join(' '));
  }
  return `${lines.join('\n')}\n`;
}

export function compareNetpbmFiles(referencePath, candidatePath, outputDir = 'out/compare') {
  if (!referencePath || !candidatePath) {
    fail('Usage: node scripts/compare-images.mjs <reference.ppm> <candidate.ppm> [outputDir]');
  }

  const reference = readAsciiNetpbm(referencePath);
  const candidate = readAsciiNetpbm(candidatePath);

  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    fail(
      `Image sizes differ: ${reference.width}x${reference.height} vs ${candidate.width}x${candidate.height}.`,
    );
  }

  const referenceMask = toBinaryMask(reference);
  const candidateMask = toBinaryMask(candidate);
  const summary = compareMasks(referenceMask, candidateMask);

  fs.mkdirSync(outputDir, { recursive: true });

  const summaryPath = path.join(outputDir, 'summary.json');
  const diffPath = path.join(outputDir, 'diff.ppm');

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(
    diffPath,
    buildDiffPpm(reference.width, reference.height, referenceMask, candidateMask),
  );

  return { summaryPath, diffPath, ...summary };
}

function main() {
  const [, , referencePath, candidatePath, outputDir = 'out/compare'] = process.argv;
  console.log(JSON.stringify(compareNetpbmFiles(referencePath, candidatePath, outputDir), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
