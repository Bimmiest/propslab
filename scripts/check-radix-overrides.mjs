#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { overrideMismatches } from './lib/radixOverrides.mjs';

const rootDir = path.join(import.meta.dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf-8'));

const issues = overrideMismatches(packageJson.overrides, packageLock.packages);

// Print results
if (issues.length > 0) {
  console.log('\nRadix UI Override Mismatch Issues:');
  console.log('==================================\n');

  const table = [];
  table.push(['Package', 'Override Version', 'Dependent Package', 'Required Version', 'Status']);
  table.push(['--------', '----------------', '-----------------', '----------------', '------']);

  for (const issue of issues) {
    const status = issue.override !== issue.dependency ? 'MISMATCH' : 'OK';
    table.push([issue.package, issue.override, issue.dependentPackage, issue.dependency, status]);
  }

  // Print formatted table
  const colWidths = [25, 18, 20, 18, 10];
  for (const row of table) {
    const formattedRow = row.map((cell, i) => cell.toString().padEnd(colWidths[i])).join(' ');
    console.log(formattedRow);
  }

  console.log('\n');
  process.exit(1);
} else {
  console.log('✓ All @radix-ui overrides match their dependencies\n');
  process.exit(0);
}
