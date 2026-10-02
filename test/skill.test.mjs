import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SKILL = fs.readFileSync(path.join(import.meta.dirname, '../skills/duru/SKILL.md'), 'utf8');

test('the agent skill says how to work through the stories in the task list and how to tag a story test', () => {
  assert.match(SKILL, /`# Stories`/);
  assert.match(SKILL, /`@story:<story ID>`/);
});
