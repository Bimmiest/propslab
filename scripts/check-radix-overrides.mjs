#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { obsoleteScopedOverrides, overrideMismatches } from './lib/radixOverrides.mjs';

const rootDir = path.join(import.meta.dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf-8'));

const issues = overrideMismatches(packageJson.overrides, packageLock.packages);
const obsolete = obsoleteScopedOverrides(packageJson.overrides, packageLock.packages);

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
}

for (const { parent, package: pkg, override } of obsolete) {
  console.log(
    `Obsolete override: ${parent} → ${pkg} ${override}. ${parent} no longer asks for an older ${pkg}; drop it.`,
  );
}

if (issues.length > 0 || obsolete.length > 0) process.exit(1);
console.log('✓ All @radix-ui overrides match their dependencies, and every scoped override is still needed\n');
