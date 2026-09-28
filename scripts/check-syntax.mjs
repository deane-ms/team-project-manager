#!/usr/bin/env node
// Syntax-checks every inline <script> block in index.html.
//
// Why this exists: the app is one big `<script type="module">` with no build step, so a single
// syntax error anywhere kills the entire page -- not just the feature that introduced it. That
// has already shipped once (commit 7ca02d4 landed a literal `&amp;&amp;` inside addDependency(),
// which took the live board down completely until someone noticed). Nothing about the deployed
// HTML looks wrong, so this is invisible without an actual parse.
//
// It also checks that index.html's CURRENT_BUILD_VERSION and version.txt carry the SAME stamp.
// Different failure, same shape of damage, and the same reason it needs a machine: the deployed
// page looks perfectly fine either way. The client polls version.txt and reloads when it differs
// from the constant baked into the page it is already running -- so if the two drift, that
// condition is true immediately after the reload as well, and every client reloads in a loop
// (every 5s via reloadIfPendingAndSafe, and on every visibilitychange). Shipped exactly once,
// by bumping version.txt alone; it presented as "the app reloads whenever I minimize and
// maximize it", which is the visibilitychange half of the loop.
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

// ---- build-stamp drift (see the header comment for why this is fatal, not cosmetic) ----
// Only meaningful when checking the real index.html; skipped when pointed at other files.
if (files.includes('index.html')) {
  const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
  const baked = html.match(/CURRENT_BUILD_VERSION\s*=\s*["']([^"']*)["']/);
  let stamp = null;
  try {
    stamp = readFileSync(resolve(repoRoot, 'version.txt'), 'utf8').trim();
  } catch {
    // falls through to the same error below
  }

  if (!baked) {
    console.error('\nCould not find CURRENT_BUILD_VERSION in index.html -- did it get renamed?');
    process.exit(1);
  }
  if (!stamp) {
    console.error('\nversion.txt is missing or empty. Clients poll it to decide when to reload.');
    process.exit(1);
  }
  if (baked[1] !== stamp) {
    console.error('\nBuild stamps disagree -- every client would reload in a loop.\n');
    console.error(`  index.html CURRENT_BUILD_VERSION : ${baked[1]}`);
    console.error(`  version.txt                      : ${stamp}\n`);
    console.error('The page reloads whenever version.txt differs from the constant baked into it,');
    console.error('so a mismatch is still true after the reload: it never converges. Set both to');
    console.error('the same timestamp before pushing:\n');
    console.error('  date -u +"%Y-%m-%dT%H:%M:%SZ"\n');
    process.exit(1);
  }
  console.log(`Build stamp matches (${stamp}).`);
}

console.log(`\nSyntax check passed (${checked} inline script${checked === 1 ? '' : 's'}).`);
