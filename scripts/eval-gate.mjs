#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluationGate } = require('../packages/core/lib/evals.js');

function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024)
    throw new Error(
      'Gate input must be a regular evaluation JSON file below 50 MB',
    );
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

try {
  const options = { thresholds: {}, maxErrors: 0, maxRegression: 0 };
  let result, baseline;
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'Usage: node scripts/eval-gate.mjs --result .aiide/evals/<run-id>.json --threshold contains=0.95 [--threshold tool_call=1] [--baseline <result.json>] [--max-errors 0] [--max-regression 0]',
    );
  } else {
    while (args.length) {
      const option = args.shift(),
        value = args.shift();
      if (!value) throw new Error(`Missing value for ${option}`);
      if (option === '--result') result = value;
      else if (option === '--baseline') baseline = value;
      else if (option === '--max-errors') options.maxErrors = Number(value);
      else if (option === '--max-regression')
        options.maxRegression = Number(value);
      else if (option === '--threshold') {
        const match = /^([a-zA-Z0-9_.-]{1,80})=(\d+(?:\.\d+)?)$/.exec(value);
        if (
          !match ||
          ['__proto__', 'constructor', 'prototype'].includes(match[1])
        )
          throw new Error('Thresholds use scorer_name=minimum from 0 to 1');
        options.thresholds[match[1]] = Number(match[2]);
      } else throw new Error(`Unknown argument: ${option}`);
    }
    if (!result) throw new Error('--result is required');
    const report = evaluationGate(
      read(result),
      options,
      baseline ? read(baseline) : undefined,
    );
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  }
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: String(error) }));
  process.exitCode = 2;
}
