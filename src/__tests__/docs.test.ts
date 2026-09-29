/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

interface PackageJson {
  scripts?: Record<string, string>;
}

describe('Documentation', () => {
  describe('Build scripts in README', () => {
    it('all npm scripts appear in README Build block', () => {
      const cwd = process.cwd();
      const packageJsonRaw = readFileSync(resolve(cwd, 'package.json'), 'utf8');
      const packageJson = JSON.parse(packageJsonRaw) as PackageJson;
      const readmeContent = readFileSync(resolve(cwd, 'README.md'), 'utf8');

      const scripts = Object.keys(packageJson.scripts ?? {});
      const readmeScripts = new Set<string>();

      // Find all npm commands in README Build section
      const buildMatch = /## Build\n([\s\S]*?)(?=\n## |$)/.exec(readmeContent);
      if (buildMatch?.[1]) {
        const buildSection = buildMatch[1];
        // Extract npm run/test commands: "npm run <script-name>" or "npm test"
        const npmRunPattern = /npm\s+run\s+([a-z0-9:.\\-]+?)(?:\s|#|$)/g;
        const npmTestPattern = /npm\s+test(?:\s|#|$)/;
        let match;
        while ((match = npmRunPattern.exec(buildSection)) !== null) {
          readmeScripts.add(match[1]);
        }
        if (npmTestPattern.test(buildSection)) {
          readmeScripts.add('test');
        }
      }

      const missing = scripts.filter(s => !readmeScripts.has(s));
      expect(missing, `Scripts missing from README: ${missing.join(', ')}`).toEqual([]);
    });

    it('all Build block scripts exist in package.json', () => {
      const cwd = process.cwd();
      const packageJsonRaw = readFileSync(resolve(cwd, 'package.json'), 'utf8');
      const packageJson = JSON.parse(packageJsonRaw) as PackageJson;
      const readmeContent = readFileSync(resolve(cwd, 'README.md'), 'utf8');

      const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
      const readmeScripts = new Set<string>();

      // Find all npm commands in README Build section
      const buildMatch = /## Build\n([\s\S]*?)(?=\n## |$)/.exec(readmeContent);
      if (buildMatch?.[1]) {
        const buildSection = buildMatch[1];
        const npmRunPattern = /npm\s+run\s+([a-z0-9:.\\-]+?)(?:\s|#|$)/g;
        const npmTestPattern = /npm\s+test(?:\s|#|$)/;
        let match;
        while ((match = npmRunPattern.exec(buildSection)) !== null) {
          readmeScripts.add(match[1]);
        }
        if (npmTestPattern.test(buildSection)) {
          readmeScripts.add('test');
        }
      }

      const invalid = Array.from(readmeScripts).filter(s => !scripts.has(s));
      expect(invalid, `Scripts in README not in package.json: ${invalid.join(', ')}`).toEqual([]);
    });
  });

  describe('Markdown links', () => {
    function getMarkdownFiles(dir: string): string[] {
      const cwd = process.cwd();
      const dirPath = resolve(cwd, dir);
      if (!existsSync(dirPath)) return [];

      const files: string[] = [];
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(resolve(dir, entry.name));
        }
      }

      return files;
    }

    const filesToCheck = [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      ...getMarkdownFiles('docs'),
      ...getMarkdownFiles('docs/adr'),
    ];

    filesToCheck.forEach(filePath => {
      it(`all relative links in ${filePath} resolve to existing files`, () => {
        const cwd = process.cwd();
        const fullPath = resolve(cwd, filePath);
        if (!existsSync(fullPath)) {
          expect.skip();
        }

        const content = readFileSync(fullPath, 'utf8');
        const fileDir = dirname(fullPath);

        // Match markdown links: [text](url)
        const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
        const brokenLinks: string[] = [];
        let match;

        while ((match = linkPattern.exec(content)) !== null) {
          const url = match[2] ?? '';
          const text = match[1] ?? '';

          // Skip http(s) links and anchors-only links
          if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('#')) {
            continue;
          }

          // Skip template placeholders like [NNNN](NNNN-title.md)
          if (text === 'NNNN' && url.startsWith('NNNN-')) {
            continue;
          }

          // Extract path (before anchor if present)
          const pathPart = url.split('#')[0];
          if (!pathPart) {
            // It's just an anchor, which we skip
            continue;
          }

          // Resolve the link
          const resolvedPath = resolve(fileDir, pathPart);

          if (!existsSync(resolvedPath)) {
            brokenLinks.push(`${filePath}: [${text}](${url}) → ${resolvedPath}`);
          }
        }

        expect(brokenLinks, `Broken links found:\n${brokenLinks.join('\n')}`).toEqual([]);
      });
    });
  });
});
