#!/usr/bin/env node
// Syntax-checks every inline <script> block in index.html.
//
// Why this exists: the app is one big `<script type="module">` with no build step, so a single
// syntax error anywhere kills the entire page -- not just the feature that introduced it. That
// has already shipped once (commit 7ca02d4 landed a literal `&amp;&amp;` inside addDependency(),
// which took the live board down completely until someone noticed). Nothing about the deployed
// HTML looks wrong, so this is invisible without an actual parse.
//
// Run directly (`node scripts/check-syntax.mjs`), via the pre-push hook in .githooks/, or in CI
// (.github/workflows/syntax-check.yml).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.slice(2);
const files = targets.length ? targets : ['index.html'];

// Matches an inline <script> (no src=) and captures its type attribute + body.
const SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;

let checked = 0;
const failures = [];
const work = mkdtempSync(join(tmpdir(), 'syntax-check-'));

try {
  for (const file of files) {
    const path = resolve(repoRoot, file);
    const html = readFileSync(path, 'utf8');

    let match;
    let index = 0;
    while ((match = SCRIPT_RE.exec(html)) !== null) {
      const [, attrs, body] = match;
      if (!body.trim()) continue;

      // JSON-LD and friends aren't JavaScript -- don't try to parse them as such.
      const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : 'text/javascript';
      const isModule = type === 'module';
      if (!isModule && !/^(text\/javascript|application\/javascript|)$/.test(type)) continue;

      // Line number of this block's opening tag, so a failure points at the real file.
      const line = html.slice(0, match.index).split('\n').length;
      const label = `${file}:${line} (<script${isModule ? ' type="module"' : ''}>)`;

      // node --check needs .mjs to accept import/export; a classic script must NOT be parsed as
      // a module, or top-level `await`/`with` and other sloppy-mode code would report false hits.
      const scratch = join(work, `block-${index++}.${isModule ? 'mjs' : 'js'}`);
      // Pad with newlines so reported line numbers line up with index.html's own.
      writeFileSync(scratch, '\n'.repeat(line - 1) + body);

      try {
        execFileSync(process.execPath, ['--check', scratch], { stdio: 'pipe' });
        checked++;
        console.log(`  ok    ${label}`);
      } catch (err) {
        const detail = (err.stderr ? err.stderr.toString() : String(err))
          .split('\n')
          .filter((l) => l.trim() && !l.includes(work) && !/^\s*at /.test(l) && !l.startsWith('Node.js v'))
          .slice(0, 6)
          .join('\n');
        failures.push({ label, detail });
        console.log(`  FAIL  ${label}`);
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error('\nSyntax check failed -- this would break the entire page, not just one feature.\n');
  for (const f of failures) {
    console.error(`${f.label}\n${f.detail}\n`);
  }
  console.error('A common cause is an HTML-escaped operator (&amp;&amp; instead of &&) getting');
  console.error('written into a script block. Fix it before pushing -- GitHub Pages will deploy');
  console.error('a broken page without complaining.\n');
  process.exit(1);
}

if (!checked) {
  console.error(`No inline scripts found in ${files.join(', ')} -- did the file move or the markup change?`);
  process.exit(1);
}

console.log(`\nSyntax check passed (${checked} inline script${checked === 1 ? '' : 's'}).`);
