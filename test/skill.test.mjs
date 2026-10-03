import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SKILL = fs.readFileSync(path.join(import.meta.dirname, '../skills/duru/SKILL.md'), 'utf8');

test('the agent skill says how to work through the stories in the task list and how to tag a story test', () => {
  assert.match(SKILL, /`# Stories`/);
  assert.match(SKILL, /`@story:<story ID>`/);
});

test('the agent skill says to copy the empty test for its runner from the task list and keep the tags in its title', () => {
  assert.match(SKILL, /`empty tests`/);
  assert.match(SKILL, /keep every tag in its title as it is/);
  assert.match(SKILL, /`test\.fixme`[\s\S]*`test\.todo`[\s\S]*`@Disabled`/);
  assert.match(SKILL, /`import org\.junit\.jupiter\.api\.Disabled;`/);
  assert.match(SKILL, /`<verdict>` \(`UPHOLDS`, `FIXED`, `HEALTHY`\s+pass;/);
});
