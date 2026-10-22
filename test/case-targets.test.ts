import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { answerProposal, caseTargets, casesWithoutTests, commandCaseRule, exclusionOf, matchesPattern, pickedKinds, ProposalChanged, rulePicks } from '../src/case-targets.ts';
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
const mark = (node: string, kindName: string, status: string, { note = '', rule, author = 'reviewer', via, of }: { note?: string; rule?: MarkRule; author?: string; via?: string; of?: string } = {}): Mark => {
  seq += 1;
  return { id: `m${String(seq).padStart(3, '0')}`, target: { node, case: kindName }, status, note, ...(rule && { rule }), author, date: `2026-10-${String(seq).padStart(2, '0')}T00:00:00.000Z`, ...(via && { via }), ...(of && { of }) };
};
const agentOut = (node: string, kindName: string, note: string, rule?: MarkRule) => mark(node, kindName, 'not-needed', { note, rule, author: 'agent', via: 'duru case' });
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
  const plain = mark('/home#Home', 'ended', 'not-needed', { note: '홈에서는 문서를 바꾸지 않는다' });
  const targets = targetsOf(caseKinds, [onCall, onScreen, plain]);
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/list'], { state: 'needed', rules: [], mark: onCall });
  assert.deepEqual(targets.ended.nodes[DETAIL], { state: 'needed', rules: [], mark: onScreen });
  assert.deepEqual(targets.ended.nodes['/home#Home'], { state: 'not-needed', rules: [], mark: plain });
  assert.equal(targets.ended.nodes['/signin#SignIn'], undefined);
  assert.deepEqual(pickedKinds(targets, DETAIL), [{ tag: 'case:ended', kind: 'case' }]);
});

test('a not-needed mark with no note on a screen or call no rule picks, such as a kind button pressed on and off again, leaves it undecided, and with a note decides it', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }), legacy: kind() };
  const off = mark('GET:/api/v1/document/list', 'ended', 'not-needed');
  const reasoned = mark('GET:/api/v1/document/{documentId}', 'ended', 'not-needed', { note: '읽기는 끝난 문서에서도 된다' });
  const offScreen = mark('/home#Home', 'legacy', 'not-needed', { note: ' ' });
  const targets = targetsOf(caseKinds, [off, reasoned, offScreen]);
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/list'], { state: 'undecided', rules: [], mark: null });
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/{documentId}'], { state: 'not-needed', rules: [], mark: reasoned });
  assert.deepEqual(targets.legacy.nodes['/home#Home'], { state: 'undecided', rules: [], mark: null });
  assert.deepEqual(targets.ended.unused, {});
  assert.ok(targets.ended.undecided.includes('GET:/api/v1/document/list'));
  assert.ok(!targets.ended.undecided.includes('GET:/api/v1/document/{documentId}'));
});

test('the undecided candidates of a kind come as requests other than GET first, then the other calls, then the screens, each group in ID order', () => {
  const targets = targetsOf({ legacy: kind(), ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) }, [mark('POST:/api/v1/report/export', 'legacy', 'needed')]);
  const calls = map.calls.map((c) => c.id).filter((id) => id !== 'POST:/api/v1/report/export');
  const writes = calls.filter((id) => !id.startsWith('GET:')).sort();
  const reads = calls.filter((id) => id.startsWith('GET:')).sort();
  assert.ok(writes.length > 0 && reads.length > 0);
  assert.deepEqual(targets.legacy.undecided, [...writes, ...reads, ...map.screens.map((s) => s.id).sort()]);
  assert.deepEqual(targets.ended.undecided, map.calls.map((c) => c.id).filter((id) => ![ARCHIVE, RENAME].includes(id)).sort((a, b) => Number(a.startsWith('GET:')) - Number(b.startsWith('GET:')) || (a < b ? -1 : 1)));
});

test('a kind picked for a screen or call by a rule or a mark has a case with no tests for each of its values no test of that screen or call carries, or for the kind itself when it has no values', () => {
  const ended = { ...kind({ screen: '/document/**', methods: ['POST', 'PUT'] }), values: ['cancelled', 'rejected'] };
  const caseKinds = { ended, legacy: kind() };
  const targets = targetsOf(caseKinds, [mark(DETAIL, 'legacy', 'needed'), mark(ARCHIVE, 'ended', 'not-needed', { note: '보관은 된다', rule: { index: 0, pick: ended.picks[0] } })]);
  const tests = { [RENAME]: [{ cases: ['case:ended=cancelled'] }, { cases: ['case:ended'] }], [DETAIL]: [{ cases: ['case:legacy'] }] };
  assert.deepEqual(casesWithoutTests('ended', ended, targets.ended, tests).map((c) => [c.node, c.target.state, c.tags]), [[RENAME, 'rule', ['case:ended=rejected']]]);
  assert.deepEqual(casesWithoutTests('legacy', caseKinds.legacy, targets.legacy, tests), []);
  assert.deepEqual(casesWithoutTests('legacy', caseKinds.legacy, targets.legacy, {}).map((c) => [c.node, c.tags]), [[DETAIL, ['case:legacy']]]);
});

test('duru case refuses a kind not in the config, a screen or call not on the map, not-needed without a note, a person\'s current mark, and not-needed off the side the rules pick unless a mark is there to take back', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }), legacy: kind() };
  const check = (marks: Mark[], args: { kind: string; node: string; status: string; note?: string }) => commandCaseRule(map, caseKinds, classifyMarks(marks, map, [], Object.keys(caseKinds)).attached, { note: '', ...args });
  assert.throws(() => check([], { kind: 'gone', node: RENAME, status: 'needed' }), /^Error: "gone" is not a kind in caseKinds \(it has ended, legacy\)$/);
  assert.throws(() => check([], { kind: 'ended', node: 'PUT:/api/v1/gone', status: 'needed' }), /^Error: PUT:\/api\/v1\/gone is no screen or call on the map$/);
  assert.throws(() => check([], { kind: 'ended', node: RENAME, status: 'not-needed' }), /a rule picks .* so taking it out needs a note saying why/);
  assert.throws(() => check([], { kind: 'legacy', node: RENAME, status: 'not-needed', note: '  ' }), /^Error: not-needed needs a note saying why legacy need not be tested on PUT/);
  assert.deepEqual(check([], { kind: 'ended', node: RENAME, status: 'not-needed', note: '이름은 막지 않는다' }), { index: 0, pick: caseKinds.ended.picks[0] });
  assert.equal(check([], { kind: 'ended', node: RENAME, status: 'needed' }), undefined);
  assert.equal(check([], { kind: 'legacy', node: DETAIL, status: 'not-needed', note: '옛 문서는 상세를 열지 않는다' }), undefined);

  const person = mark(RENAME, 'legacy', 'needed', { author: '검토자' });
  assert.throws(() => check([person], { kind: 'legacy', node: RENAME, status: 'needed' }), /^Error: 검토자 marked legacy needed on PUT:\/api\/v1\/document\/\{documentId\}\/name on 2026-10-\d\d, and duru case does not change a person's mark$/);
  const agent = { ...mark(RENAME, 'legacy', 'needed', { author: 'agent' }), via: 'duru case' };
  assert.equal(check([person, agent], { kind: 'legacy', node: RENAME, status: 'not-needed', note: '이름은 막지 않는다' }), undefined);
  assert.throws(() => check([mark(RENAME, 'legacy', 'not-needed', { author: '검토자' })], { kind: 'legacy', node: RENAME, status: 'needed' }), /^Error: 검토자 marked legacy not-needed on PUT:\/api\/v1\/document\/\{documentId\}\/name on 2026-10-\d\d, and duru case does not change a person's mark$/);
  const unused = mark(RENAME, 'legacy', 'not-needed', { note: '이름은 막지 않는다', rule: { index: 0, pick: { methods: ['PUT'] } }, author: '검토자' });
  assert.throws(() => check([unused], { kind: 'legacy', node: RENAME, status: 'needed' }), /^Error: 검토자 marked legacy not-needed on .*, and duru case does not change a person's mark$/);
  assert.throws(() => check([mark(RENAME, 'ended', 'not-needed', { author: '검토자' })], { kind: 'ended', node: RENAME, status: 'needed' }), /^Error: 검토자 marked ended not-needed on /);

  assert.throws(() => check([], { kind: 'ended', node: DETAIL, status: 'not-needed', note: '화면은 고르지 않는다' }), /^Error: the rules of ended pick only calls, so \/document\/:id#DocumentDetail is no candidate/);
  assert.equal(check([], { kind: 'ended', node: DETAIL, status: 'needed' }), undefined);
  const agentOnScreen = { ...mark(DETAIL, 'ended', 'needed', { author: 'agent' }), via: 'duru case' };
  assert.equal(check([agentOnScreen], { kind: 'ended', node: DETAIL, status: 'not-needed', note: '잘못 골랐다' }), undefined);
});

test('an agent\'s not-needed waits for a reviewer: the candidate stays as it was, a rule\'s target a target with its cases with no tests and a candidate no rule picks counted under review only, not undecided', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const ruled = agentOut(RENAME, 'ended', '이름은 막지 않는다', { index: 0, pick: caseKinds.ended.picks[0] });
  const free = agentOut('GET:/api/v1/document/list', 'ended', '목록은 읽기만 한다');
  const targets = targetsOf(caseKinds, [ruled, free]);
  assert.deepEqual(targets.ended.nodes[RENAME], { state: 'rule', rules: [0], mark: null, review: ruled });
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/list'], { state: 'undecided', rules: [], mark: null, review: free });
  assert.deepEqual(targets.ended.review, [RENAME, 'GET:/api/v1/document/list']);
  assert.ok(!targets.ended.undecided.includes('GET:/api/v1/document/list'));
  assert.deepEqual(pickedKinds(targets, RENAME), [{ tag: 'case:ended', kind: 'case' }]);
  assert.deepEqual(casesWithoutTests('ended', caseKinds.ended, targets.ended, {}).map((c) => c.node), [ARCHIVE, RENAME]);
  const person = mark('GET:/api/v1/document/{documentId}', 'ended', 'not-needed', { note: '읽기는 된다' });
  assert.deepEqual(targetsOf(caseKinds, [person]).ended.nodes['GET:/api/v1/document/{documentId}'], { state: 'not-needed', rules: [], mark: person });
  const agentNeeded = mark(DETAIL, 'ended', 'needed', { author: 'agent', via: 'duru case' });
  assert.equal(targetsOf(caseKinds, [agentNeeded]).ended.nodes[DETAIL].state, 'needed');
});

test('an agent\'s not-needed over a person\'s mark leaves that mark in force while it waits, also over another not-needed of the agent, and one taken out of a rule that no longer picks it waits too instead of being no longer used', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST'] }) };
  const person = mark('GET:/api/v1/document/list', 'ended', 'needed', { author: '김민' });
  const first = agentOut('GET:/api/v1/document/list', 'ended', '목록은 읽기만 한다');
  const second = agentOut('GET:/api/v1/document/list', 'ended', '목록은 문서를 바꾸지 않는다');
  const narrowed = agentOut(RENAME, 'ended', '이름은 막지 않는다', { index: 0, pick: { screen: '/document/**', methods: ['POST', 'PUT'] } });
  const targets = targetsOf(caseKinds, [person, first, second, narrowed]);
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/list'], { state: 'needed', rules: [], mark: person, review: second });
  assert.deepEqual(targets.ended.nodes[RENAME], { state: 'undecided', rules: [], mark: null, review: narrowed });
  assert.deepEqual(targets.ended.unused, {});
  assert.deepEqual(targets.ended.review, [RENAME, 'GET:/api/v1/document/list']);
});

test('a reviewer\'s answer naming the agent\'s mark ends the wait: accepting takes the candidate out with the agent\'s reason, reverting puts back the person\'s mark under it or, with none, leaves a rule\'s target to the rule and a candidate no rule picks undecided', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const rule = { index: 0, pick: caseKinds.ended.picks[0] };
  const ruled = agentOut(RENAME, 'ended', '이름은 막지 않는다', rule);
  const free = agentOut('GET:/api/v1/document/list', 'ended', '목록은 읽기만 한다');
  const person = mark('GET:/api/v1/document/{documentId}', 'ended', 'needed', { author: '김민' });
  const over = agentOut('GET:/api/v1/document/{documentId}', 'ended', '상세는 읽기만 한다');
  const accepted = mark(RENAME, 'ended', 'not-needed', { note: ruled.note, rule, of: ruled.id });
  const reverted = mark('GET:/api/v1/document/list', 'ended', 'not-needed', { of: free.id });
  const back = mark('GET:/api/v1/document/{documentId}', 'ended', 'needed', { of: over.id });
  const targets = targetsOf(caseKinds, [ruled, free, person, over, accepted, reverted, back]);
  assert.deepEqual(targets.ended.nodes[RENAME], { state: 'not-needed', rules: [0], mark: accepted });
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/list'], { state: 'undecided', rules: [], mark: null });
  assert.deepEqual(targets.ended.nodes['GET:/api/v1/document/{documentId}'], { state: 'needed', rules: [], mark: back });
  assert.deepEqual(targets.ended.review, []);
  const revertedRule = mark(RENAME, 'ended', 'not-needed', { of: ruled.id });
  assert.deepEqual(targetsOf(caseKinds, [ruled, revertedRule]).ended.nodes[RENAME], { state: 'rule', rules: [0], mark: null });
});

test('the answer to an agent\'s not-needed copies its reason on accepting, the person\'s mark under it or a not-needed without a note on reverting, and names the agent\'s mark; it is refused once the agent wrote again or nothing waits', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const attached = (marks: Mark[]) => classifyMarks(marks, map, [], ['ended']).attached;
  const rule = { index: 0, pick: caseKinds.ended.picks[0] };
  const ruled = agentOut(RENAME, 'ended', '이름은 막지 않는다', rule);
  assert.deepEqual(answerProposal(map, caseKinds, attached([ruled]), { kind: 'ended', node: RENAME, of: ruled.id, answer: 'accept' }), { target: { node: RENAME, case: 'ended' }, status: 'not-needed', note: '이름은 막지 않는다', rule, of: ruled.id });
  assert.deepEqual(answerProposal(map, caseKinds, attached([ruled]), { kind: 'ended', node: RENAME, of: ruled.id, answer: 'revert' }), { target: { node: RENAME, case: 'ended' }, status: 'not-needed', note: '', rule: undefined, of: ruled.id });
  const person = mark(DETAIL, 'ended', 'not-needed', { note: '상세는 읽기만 한다', author: '김민' });
  const agentNeeded = mark(DETAIL, 'ended', 'needed', { author: 'agent', via: 'duru case' });
  const over = agentOut(DETAIL, 'ended', '화면은 고르지 않는다');
  assert.deepEqual(answerProposal(map, caseKinds, attached([person, agentNeeded, over]), { kind: 'ended', node: DETAIL, of: over.id, answer: 'revert' }), { target: { node: DETAIL, case: 'ended' }, status: 'not-needed', note: '상세는 읽기만 한다', rule: undefined, of: over.id });
  const again = agentOut(RENAME, 'ended', '이름은 끝난 뒤에도 바꾼다', rule);
  assert.throws(() => answerProposal(map, caseKinds, attached([ruled, again]), { kind: 'ended', node: RENAME, of: ruled.id, answer: 'accept' }), (err) => err instanceof ProposalChanged && /^the agent wrote ended on PUT:.* again after the page read it$/.test(err.message));
  assert.throws(() => answerProposal(map, caseKinds, attached([ruled, mark(RENAME, 'ended', 'needed')]), { kind: 'ended', node: RENAME, of: ruled.id, answer: 'accept' }), (err) => err instanceof ProposalChanged && /^no agent not-needed for ended on PUT:.* waits for a reviewer any more$/.test(err.message));
});

test('duru case may put a not-needed over a person\'s mark, but not a needed, also not over its own not-needed that waits on top of that mark, and once a reviewer reverted the agent\'s not-needed it refuses both', () => {
  const caseKinds = { ended: kind({ screen: '/document/**', methods: ['POST', 'PUT'] }) };
  const check = (marks: Mark[], status: string) => commandCaseRule(map, caseKinds, classifyMarks(marks, map, [], ['ended']).attached, { kind: 'ended', node: 'GET:/api/v1/document/list', status, note: '목록은 읽기만 한다' });
  const person = mark('GET:/api/v1/document/list', 'ended', 'needed', { author: '김민' });
  assert.equal(check([person], 'not-needed'), undefined);
  assert.throws(() => check([person], 'needed'), /duru case does not change a person's mark$/);
  const proposal = agentOut('GET:/api/v1/document/list', 'ended', '목록은 읽기만 한다');
  assert.throws(() => check([person, proposal], 'needed'), /^Error: 김민 marked ended needed on GET:\/api\/v1\/document\/list on 2026-10-\d\d, and duru case does not change a person's mark$/);
  assert.equal(check([person, proposal], 'not-needed'), undefined);
  assert.equal(check([proposal], 'needed'), undefined);
  const accepted = mark('GET:/api/v1/document/list', 'ended', 'not-needed', { note: proposal.note, author: '김민', of: proposal.id });
  assert.equal(check([proposal, accepted], 'not-needed'), undefined);
  const reverted = { ...mark('GET:/api/v1/document/list', 'ended', 'not-needed', { author: '김민', of: proposal.id }), date: '2026-10-30T00:00:00.000Z' };
  for (const status of ['needed', 'not-needed']) {
    assert.throws(() => check([proposal, reverted], status), /^Error: 김민 took back the agent's not-needed for ended on GET:\/api\/v1\/document\/list on 2026-10-30, so only a person decides it now$/);
  }
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
  assert.throws(() => exclusionOf(() => map, caseKinds, { target, status: 'not-needed' }), /^Error: a rule picks PUT:\/api\/v1\/document\/\{documentId\}\/name for ended \(caseKinds\.ended\.picks\[1\]\), so taking it out needs a note saying why$/);
  assert.throws(() => exclusionOf(() => map, caseKinds, { target, status: 'not-needed', note: '  ' }), /needs a note/);
  assert.deepEqual(exclusionOf(() => map, caseKinds, { target, status: 'not-needed', note: '이름은 막지 않는다' }), { index: 1, pick: { screen: '/document/**', methods: ['PUT'] } });
  assert.throws(() => exclusionOf(() => map, caseKinds, { targets: [target], status: 'not-needed' }), /needs a note/);
  assert.equal(exclusionOf(() => map, caseKinds, { target, status: 'needed' }), undefined);
  assert.equal(exclusionOf(() => map, caseKinds, { target: { node: ARCHIVE, case: 'ended' }, status: 'not-needed' }), undefined);
  assert.equal(exclusionOf(() => map, caseKinds, { target: { node: RENAME, case: 'legacy' }, status: 'not-needed' }), undefined);
  assert.equal(exclusionOf(() => map, caseKinds, { target: { node: RENAME, case: 'gone' }, status: 'not-needed' }), undefined);
  assert.equal(exclusionOf(() => map, caseKinds, { target: { node: RENAME, case: 'constructor' }, status: 'not-needed' }), undefined);
});

test('the README and the agent skill say what picks takes, what its rebuild lines mean and how to read a case mark taken out of a rule', () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
  const readme = read('../README.md');
  assert.match(readme, /can also carry `picks`, a list of rules[\s\S]*`screen`[\s\S]*`methods`[\s\S]*`api`/);
  assert.match(readme, /`\*` stands for one whole part between\s+`\/`s and `\*\*` for any number of parts, none included/);
  assert.match(readme, /`case kind <kind>: rules pick N screens, N calls`/);
  assert.match(readme, /`caseKinds <kind> picks\[<i>\] matches no screen\|call: <rule>`/);
  assert.match(readme, /「규칙」 when a rule in `picks` did[\s\S]*「이 요청은 규칙에서 빼기…」/);
  assert.match(readme, /it also carries `rule`, `\{ "index": <place in picks, from 0>, "pick": <the\s+rule as written> \}`/);
  const skill = read('../skills/duru/SKILL.md');
  assert.match(skill, /a kind of case a reviewer, or a rule in the config's `caseKinds`\s+`picks`, picked for it/);
  assert.match(skill, /`caseKinds <kind> picks\[<i>\] matches no screen` \(or `no call`\)/);
  assert.match(skill, /A `not-needed` case mark that also carries\s+`rule`, `\{ "index", "pick" \}`/);
});

test('the README, the agent skill and the decision record say what case and undecided do, their exit codes, the field case writes and how to read the case kinds section', () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
  const readme = read('../README.md');
  assert.match(readme, /`case <config> <kind> <screen or call ID> needed\|not-needed \[--note "<why>"\] \[--author <name> \| --server <review page address>\]`/);
  assert.match(readme, /With `--server` and the address the review printed, the mark\s+goes through the running review instead/);
  assert.match(readme, /`--author` with `--server` stops with `a case sent with --server is always by\s+agent; leave out --author` and exit code 2/);
  assert.match(readme, /It exits with 0 when none is left, 3 while any is, 1 when the config, the\s+map or a mark file cannot be read/);
  assert.match(readme, /`"via": "duru case"`/);
  assert.match(readme, /`case kind <kind>: undecided N \| cases with no tests N`/);
  assert.match(readme, /\*\*Case kinds\.\*\* With `caseKinds` set, `# Case kinds` comes before `# Tagging`/);
  const skill = read('../skills/duru/SKILL.md');
  assert.match(skill, /`duru case <config> <kind> <ID> needed`/);
  assert.match(skill, /This\s+part is done when every candidate `duru undecided` still lists is one only a person can decide/);
  assert.match(skill, /Without `--server` the\s+marks are written straight into the marks folder, so an open review page shows them only once it is reloaded/);
  assert.match(skill, /While a review you launched is running, add `--server <the review page address>`\s+and leave out `--author`/);
  const decisions = read('../docs/decisions.md');
  assert.match(decisions, /\*\*An agent decides a kind of case for a screen or call with `duru case`/);
  assert.match(decisions, /\*\*An agent sends a case decision to a running review with `duru case … --server <review page address>`/);
  assert.doesNotMatch(decisions, /a way through the review server is left for another issue/);
  assert.match(decisions, /since #314 a picked kind with a case no test carries is listed under\s+`# Case kinds`/);
});

test('the decision record says the review server\'s check and rebuild call the rule matcher the page data uses, without reading its table', () => {
  const decisions = fs.readFileSync(path.join(import.meta.dirname, '../docs/decisions.md'), 'utf8');
  assert.match(decisions, /The review data and the task list, which is made from that data, read it; the review\s+server's check of a `not-needed` mark and `rebuild` call the same rule matcher \(`rulePicks`\) without the marks/);
  assert.doesNotMatch(decisions, /the review server's check and `rebuild` all read it/);
});

test('the README and the decision record say what a reviewer sees of an agent\'s not-needed under review, what the answer writes with of, and what was compared', () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
  const readme = read('../README.md');
  assert.match(readme, /`\| under review N`/);
  assert.match(readme, /「테스트 관점 N」[\s\S]*「미판정 U · 검토 중 R」/);
  assert.match(readme, /「검토 중 N」 lists, open and in the same three groups[\s\S]*「✓ N」 accepts and 「✕ N」 reverts them all/);
  assert.match(readme, /`"of": "<ID of the agent's mark>"`/);
  assert.match(readme, /`under review: N` follows `undecided`/);
  assert.match(readme, /`took back the agent's not-needed` for one a\s+reviewer reverted/);
  assert.match(readme, /a reviewer's answer to an agent's 「대상 아님」 reads 받아들임 or 되돌림/);
  const decisions = read('../docs/decisions.md');
  assert.match(decisions, /\*\*An agent's 「대상 아님」 waits under review until a reviewer accepts it on the review page/);
  assert.match(decisions, /- A new status value, `under-review`[\s\S]*- A review record with no status[\s\S]*older `duru wait`[\s\S]*- No new field/);
});

test('the README, the agent instructions and the decision record quote the page as 「테스트 관점」 and 「관점별 테스트」, while the config key and the command lines keep caseKinds and case kind', () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
  const [readme, skill, decisions] = [read('../README.md'), read('../skills/duru/SKILL.md'), read('../docs/decisions.md')];
  for (const doc of [readme, skill]) assert.doesNotMatch(doc, /「경우 종류|「경우별 테스트」/);
  assert.match(readme, /the list has a third tab, 「테스트 관점 N」/);
  assert.match(readme, /With `caseKinds` set, 「관점별 테스트」 has a button per kind/);
  assert.match(readme, /`case kind <kind>: undecided N/);
  assert.match(skill, /the review page's 「테스트 관점」 tab/);
  assert.match(decisions, /\*\*The review page calls the case kinds 「테스트 관점」 and the tests of each kind on a screen or call\s+「관점별 테스트」/);
});
