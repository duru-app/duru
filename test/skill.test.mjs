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

test('the agent skill says what an unchecked server match means when there is no server API list', () => {
  assert.match(SKILL, /`unchecked`/);
  assert.match(SKILL, /no call is dead and no screen is a dead screen/);
  assert.match(SKILL, /`server: not checked`/);
});

test('the agent skill says what an importing test is and how to add the tag a Tagging item asks for', () => {
  assert.match(SKILL, /importing[\s\S]*not counted as tests of the screen until they carry the screen's tag/);
  assert.match(SKILL, /`# Tagging`/);
  assert.match(SKILL, /add exactly\s+the tag in `tag to add`[\s\S]*change nothing else in the test/);
  assert.match(SKILL, /`tag` option of the test for Playwright[\s\S]*Vitest[\s\S]*`@DisplayName` for JUnit[\s\S]*`VERDICT` line/);
  assert.match(SKILL, /item leaves the\s+list once the tag is read/);
  assert.match(SKILL, /item stays when the result\s+file was not rewritten or the tag is not the one given/);
  assert.match(SKILL, /left the list is done only if the test now\s+appears as a tagged test[\s\S]*count did not\s+go up[\s\S]*change nothing in the title except appending the tag, and do not move the file/);
});
