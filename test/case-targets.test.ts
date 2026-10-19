import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { caseTargets, exclusionOf, matchesPattern, pickedKinds, rulePicks } from '../src/case-targets.ts';
import { loadConfig } from '../src/config.ts';
import type { CaseKind, CasePick } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import { classifyMarks } from '../src/marks.ts';
import type { Mark, MarkRule } from '../src/marks.ts';

const map = await buildMap(loadConfig(path.join(import.meta.dirname, 'fixtures/app/config.json')));
const kind = (...picks: CasePick[]): CaseKind => ({ text: '끝난 문서', values: [], picks });
const picked = (...picks: CasePick[]) => rulePicks(map, kind(...picks)).map(({ screens, calls }) => [...screens, ...calls]);

const RENAME = 'PUT:/api/v1/document/{documentId}/name';
const ARCHIVE = 'POST:/api/v1/archive/document';
const DETAIL = '/document/:id#DocumentDetail';

let seq = 0;
const mark = (node: string, kindName: string, status: string, { note = '', rule, author = 'reviewer' }: { note?: string; rule?: MarkRule; author?: string } = {}): Mark => {
  seq += 1;
  return { id: `m${String(seq).padStart(3, '0')}`, target: { node, case: kindName }, status, note, ...(rule && { rule }), author, date: `2026-10-${String(seq).padStart(2, '0')}T00:00:00.000Z` };
};
const targetsOf = (caseKinds: Record<string, CaseKind>, marks: Mark[]) => caseTargets(map, caseKinds, classifyMarks(marks, map, [], Object.keys(caseKinds)).attached);

test('a pattern part matches only a whole path part, and ** also matches no part', () => {
  assert.equal(matchesPattern('/document/*', '/document/:id'), true);
  assert.equal(matchesPattern('/document/*', '/document'), false);
  assert.equal(matchesPattern('/document/*', '/document/:id/name'), false);
  assert.equal(matchesPattern('/document/**', '/document'), true);
  assert.equal(matchesPattern('/document/**', '/document/{documentId}/name'), true);
  assert.equal(matchesPattern('/document/**/name', '/document/name'), true);
  assert.equal(matchesPattern('/document/**/name', '/document/{documentId}/title'), false);
  assert.equal(matchesPattern('/doc', '/document'), false);
  assert.equal(matchesPattern('/**', '/'), true);
});

test('a rule with only a screen path picks the screens whose path matches, * one part and ** any number of parts', () => {
  assert.deepEqual(picked({ screen: '/admin/*' }), [['/admin/member#AdminMember', '/admin/group#AdminGroup', '/admin/audit#AdminAudit', '/admin/report#AdminReport']]);
  assert.deepEqual(picked({ screen: '/lab/**' }, { screen: '/lab/*' }), [['/lab#Lab', '/lab/result#LabResult'], ['/lab/result#LabResult']]);
  assert.deepEqual(picked({ screen: '/document/*' }), [['/document/:tab#DocumentList', DETAIL]]);
  assert.deepEqual(picked({ screen: '/document/:id' }), [[DETAIL]]);
  assert.deepEqual(picked({ screen: '/**' }), [map.screens.map((s) => s.id)]);
});

test('a rule with methods or a request address picks the calls the matching screens send, and with no screen path picks among every call', () => {
  assert.deepEqual(picked({ screen: '/document/**', methods: ['POST', 'PUT'] }), [[ARCHIVE, RENAME]]);
  assert.deepEqual(picked({ api: '/api/v1/report/*' }), [['POST:/api/v1/report/archive', 'POST:/api/v1/report/export', 'POST:/api/v1/report/schedule']]);
  assert.deepEqual(picked({ methods: ['PUT', 'DELETE'] }), [[RENAME]]);
  assert.deepEqual(picked({ screen: '/home', api: '/**' }), [['GET:/api/v1/document/list', ARCHIVE]]);
});

test('every part a rule writes has to match', () => {
  assert.deepEqual(picked({ methods: ['GET'], api: '/api/v1/document/*' }), [['GET:/api/v1/document/list', 'GET:/api/v1/document/{documentId}']]);
  assert.deepEqual(picked({ screen: '/home', methods: ['GET'], api: '/api/v1/document/*' }), [['GET:/api/v1/document/list']]);
  assert.deepEqual(picked({ screen: '/admin/**', api: '/api/v1/document/**' }), [[]]);
  assert.deepEqual(picked({ screen: '/document/**', methods: ['DELETE'] }), [[]]);
});

test('a candidate no rule and no mark picks is undecided, and a kind without rules has every screen and call as a candidate', () => {
  const targets = targetsOf({ ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }), legacy: kind() }, []);
  assert.deepEqual(targets.ended.sides, { screens: false, calls: true });
  assert.deepEqual(Object.keys(targets.ended.nodes), map.calls.map((c) => c.id));
  assert.deepEqual(targets.ended.nodes[RENAME], { state: 'rule', rules: [0], mark: null });
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/list'], { state: 'undecided', rules: [], mark: null });
  assert.deepEqual(targets.legacy.sides, { screens: true, calls: true });
  assert.deepEqual(Object.keys(targets.legacy.nodes), [...map.screens, ...map.calls].map((n) => n.id));
  assert.ok(Object.values(targets.legacy.nodes).every((n) => n.state === 'undecided'));
  assert.deepEqual(pickedKinds(targets, RENAME), [{ tag: 'case:ended', kind: 'case' }]);
  assert.deepEqual(pickedKinds(targets, DETAIL), []);
});

test('a not-needed mark that took a call out of a rule beats the rule with its author, date and reason, and a later needed mark puts it back as that person\'s pick', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const rule = { index: 0, pick: caseKinds.ended.picks[0] };
  const out = mark(RENAME, 'ended', 'not-needed', { note: '이름은 끝난 문서에서도 막지 않는다', rule, author: 'QA 에이전트' });
  const excluded = targetsOf(caseKinds, [out]);
  assert.deepEqual(excluded.ended.nodes[RENAME], { state: 'not-needed', rules: [0], mark: out });
  assert.deepEqual(pickedKinds(excluded, RENAME), []);
  const back = mark(RENAME, 'ended', 'needed');
  const again = targetsOf(caseKinds, [out, back]);
  assert.deepEqual(again.ended.nodes[RENAME], { state: 'needed', rules: [0], mark: back });
  assert.deepEqual(pickedKinds(again, RENAME), [{ tag: 'case:ended', kind: 'case' }]);
});

test('a not-needed mark with no rule in it, such as a kind button pressed off before the rule was written, does not beat the rule', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const targets = targetsOf(caseKinds, [mark(RENAME, 'ended', 'needed'), mark(RENAME, 'ended', 'not-needed'), mark(ARCHIVE, 'ended', 'not-needed', { note: '까닭은 있지만 규칙 전에 적음' })]);
  assert.deepEqual(targets.ended.nodes[RENAME], { state: 'rule', rules: [0], mark: null });
  assert.deepEqual(targets.ended.nodes[ARCHIVE], { state: 'rule', rules: [0], mark: null });
  assert.deepEqual(targets.ended.unused, {});
});

test('a needed mark on a screen or call no rule picks makes it a target picked by its author, also on the side the rules do not name', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const onCall = mark('GET:/api/v1/document/list', 'ended', 'needed', { author: 'QA 에이전트' });
  const onScreen = mark(DETAIL, 'ended', 'needed');
  const plain = mark('/home#Home', 'ended', 'not-needed');
  const targets = targetsOf(caseKinds, [onCall, onScreen, plain]);
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/list'], { state: 'needed', rules: [], mark: onCall });
  assert.deepEqual(targets.ended.nodes[DETAIL], { state: 'needed', rules: [], mark: onScreen });
  assert.deepEqual(targets.ended.nodes['/home#Home'], { state: 'not-needed', rules: [], mark: plain });
  assert.equal(targets.ended.nodes['/signin#SignIn'], undefined);
  assert.deepEqual(pickedKinds(targets, DETAIL), [{ tag: 'case:ended', kind: 'case' }]);
});

test('a rule that picks nothing is reported by its kind and its place in picks', () => {
  const targets = targetsOf({ ended: kind({ screen: '/document/**', methods: ['POST'] }, { screen: '/participant/**', methods: ['POST'] }, { screen: '/nowhere' }) }, []);
  assert.deepEqual(targets.ended.rules.map((r) => [r.pick, r.screens.length + r.calls.length]), [
    [{ screen: '/document/**', methods: ['POST'] }, 1],
    [{ screen: '/participant/**', methods: ['POST'] }, 0],
    [{ screen: '/nowhere' }, 0],
  ]);
  assert.deepEqual(targets.ended.sides, { screens: true, calls: true });
});

test('a mark that took a call out of a rule no rule picks any more is listed as no longer used, also when its kind lost every rule, and the call counts as undecided', () => {
  const rule = { index: 0, pick: { screen: '/document/**', methods: ['POST', 'PUT'] } };
  const out = mark(RENAME, 'ended', 'not-needed', { note: '이름은 막지 않는다', rule });
  const narrowed = targetsOf({ ended: kind({ screen: '/document/**', methods: ['POST'] }) }, [out]);
  assert.deepEqual(narrowed.ended.unused, { [RENAME]: out });
  assert.deepEqual(narrowed.ended.nodes[RENAME], { state: 'undecided', rules: [], mark: null });
  const noRules = targetsOf({ ended: kind() }, [out]);
  assert.deepEqual(noRules.ended.unused, { [RENAME]: out });
  assert.deepEqual(noRules.ended.nodes[RENAME], { state: 'undecided', rules: [], mark: null });
  const screenRule = targetsOf({ ended: kind({ screen: '/admin/**' }) }, [out]);
  assert.deepEqual(screenRule.ended.unused, { [RENAME]: out });
  assert.equal(screenRule.ended.nodes[RENAME], undefined);
});

test('a mark whose screen or call left the map or whose kind left caseKinds is not in the table but among the detached marks', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const marks = [mark('PUT:/api/v1/gone', 'ended', 'needed'), mark(RENAME, 'legacy', 'needed')];
  const { attached, detached } = classifyMarks(marks, map, [], Object.keys(caseKinds));
  const targets = caseTargets(map, caseKinds, attached);
  assert.deepEqual(Object.keys(targets), ['ended']);
  assert.equal(targets.ended.nodes['PUT:/api/v1/gone'], undefined);
  assert.deepEqual(detached.map((e) => e.key).sort(), [`${RENAME} case:legacy`, 'PUT:/api/v1/gone case:ended']);
});

test('taking a screen or call out of a rule needs a note and names the first rule that picks it; elsewhere a not-needed mark needs neither', () => {
  const caseKinds = { ended: kind({ screen: '/nowhere' }, { screen: '/document/**', methods: ['PUT'] }), legacy: kind() };
  const target = { node: RENAME, case: 'ended' };
  assert.throws(() => exclusionOf(map, caseKinds, { target, status: 'not-needed' }), /^Error: a rule picks PUT:\/api\/v1\/document\/\{documentId\}\/name for ended \(caseKinds\.ended\.picks\[1\]\), so taking it out needs a note saying why$/);
  assert.throws(() => exclusionOf(map, caseKinds, { target, status: 'not-needed', note: '  ' }), /needs a note/);
  assert.deepEqual(exclusionOf(map, caseKinds, { target, status: 'not-needed', note: '이름은 막지 않는다' }), { index: 1, pick: { screen: '/document/**', methods: ['PUT'] } });
  assert.equal(exclusionOf(map, caseKinds, { target, status: 'needed' }), undefined);
  assert.equal(exclusionOf(map, caseKinds, { target: { node: ARCHIVE, case: 'ended' }, status: 'not-needed' }), undefined);
  assert.equal(exclusionOf(map, caseKinds, { target: { node: RENAME, case: 'legacy' }, status: 'not-needed' }), undefined);
  assert.equal(exclusionOf(map, caseKinds, { target: { node: RENAME, case: 'gone' }, status: 'not-needed' }), undefined);
  assert.equal(exclusionOf(map, caseKinds, { target: { node: RENAME, case: 'constructor' }, status: 'not-needed' }), undefined);
});
