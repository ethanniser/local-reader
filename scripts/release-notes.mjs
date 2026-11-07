#!/usr/bin/env node
// Print the CHANGELOG.md section for a release, or validate the changelog.
//
//   node scripts/release-notes.mjs 0.2.0    notes for v0.2.0 (exits 1 if missing)
//   node scripts/release-notes.mjs --check  validate headings and package.json version
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const HEADING = /^## \[(Unreleased|\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;

export function sections(text) {
  const result = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const match = HEADING.exec(line);
      if (!match) throw new Error(`Malformed changelog heading: ${line}`);
      current = { version: match[1], date: match[2] ?? null, lines: [] };
      result.push(current);
    } else if (current && !/^\[[^\]]+\]: /.test(line)) {
      current.lines.push(line);
    }
  }
  return result.map(({ lines, ...rest }) => ({ ...rest, body: lines.join('\n').trim() }));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function check() {
  const all = sections(changelog);
  if (all[0]?.version !== 'Unreleased') fail('CHANGELOG.md must start with an "## [Unreleased]" section.');
  const seen = new Set();
  for (const { version, date } of all.slice(1)) {
    if (version === 'Unreleased') fail('Only the first section may be Unreleased.');
    if (!date) fail(`Released section ${version} needs a date: "## [${version}] - YYYY-MM-DD".`);
    if (seen.has(version)) fail(`Duplicate changelog section for ${version}.`);
    seen.add(version);
  }
  const released = all.slice(1).map((s) => s.version);
  if (released.length && released[0] !== pkg.version) {
    fail(`package.json is ${pkg.version}, but the newest released changelog section is ${released[0]}.`);
  }
  console.log(`CHANGELOG.md is valid (${released.length} released version${released.length === 1 ? '' : 's'}; package.json ${pkg.version}).`);
}

function notes(version) {
  version = version.replace(/^v/, '');
  if (version !== pkg.version) fail(`Tag v${version} does not match package.json version ${pkg.version}.`);
  const section = sections(changelog).find((s) => s.version === version);
  if (!section) fail(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section.`);
  if (!section.date) fail(`CHANGELOG.md section ${version} has no release date.`);
  if (!section.body) fail(`CHANGELOG.md section ${version} is empty.`);
  process.stdout.write(section.body + '\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [arg] = process.argv.slice(2);
  if (!arg) fail('Usage: release-notes.mjs <version> | --check');
  arg === '--check' ? check() : notes(arg);
}
