import { linkTargets, unreadableTarget } from './access.mjs';
import { compare } from './config.mjs';
import path from 'node:path';
import { isScreenList, loadStories, STORY_ID } from './stories.mjs';

const byPlace = (a, b) => compare(a.file, b.file) || a.line - b.line;

export function checkStories(map, stories) {
  const indexOf = new Map(map.screens.map((s, i) => [s.id, i]));
  const targetsOf = linkTargets(map.screens);
  const movesBetween = new Map();
  for (const m of map.moves ?? []) {
    const key = `${m.from} ${m.to}`;
    movesBetween.set(key, [...(movesBetween.get(key) ?? []), m.reason]);
  }

  const linkBetween = (fromId, toId) => {
    const fromIndex = indexOf.get(fromId);
    const from = map.screens[fromIndex];
    const ways = from.links
      .filter((l) => targetsOf(l.to, l.tail, fromIndex).includes(indexOf.get(toId)))
      .map((l) => ({ file: l.file, line: l.line, conditions: l.conditions }))
      .sort(byPlace);
    // 조건 없는 링크가 하나라도 있으면 빼 둔 링크가 판정을 바꾸지 못하므로 알리지 않는다.
    if (ways.some((w) => !w.conditions.length)) return { verdict: 'open', ways };
    const reasons = movesBetween.get(`${fromId} ${toId}`);
    if (reasons) return { verdict: 'configured', reasons, ways: [] };
    const unknownLinks = from.links.filter((l) => unreadableTarget(l.to)).map((l) => ({ file: l.file, line: l.line, to: l.to })).sort(byPlace);
    const skipped = unknownLinks.length ? { unknownLinks } : {};
    if (ways.length) return { verdict: 'conditioned', ways, ...skipped };
    return { verdict: unknownLinks.length ? 'unknown' : 'broken', ways, ...skipped };
  };

  return stories.map((story) => {
    const steps = story.screens.map((screen) => ({ screen, onMap: indexOf.has(screen) }));
    const links = steps.slice(1).map((to, i) => {
      const from = steps[i];
      if (!from.onMap || !to.onMap) return { from: from.screen, to: to.screen, verdict: 'off-map', ways: [] };
      return { from: from.screen, to: to.screen, ...linkBetween(from.screen, to.screen) };
    });

    const reach = [];
    steps.forEach((step, i) => {
      const into = links[i - 1];
      if (into?.verdict === 'conditioned') reach.push({ kind: 'link', from: into.from, to: step.screen, ways: into.ways, ...(into.unknownLinks && { unknownLinks: into.unknownLinks }) });
      if (!step.onMap) return;
      const s = map.screens[indexOf.get(step.screen)];
      if (i === 0 && s.access.restricted) {
        reach.push({ kind: 'start', screen: s.id, kinds: s.access.kinds, ...(s.access.roleValues !== undefined && { roleValues: s.access.roleValues }) });
      }
      if (s.access.route.length) reach.push({ kind: 'route', screen: s.id, line: s.line, guards: s.access.route });
    });

    return {
      ...story,
      steps,
      links,
      reach,
      detached: steps.some((s) => !s.onMap),
      broken: links.some((l) => l.verdict === 'broken'),
      unjudged: links.some((l) => l.verdict === 'unknown'),
    };
  });
}

const NO_TESTS = { nodes: {}, stories: {} };
// 스토리 파일에 적힌 ID 가 constructor 같은 이름이어도 Object 의 기본 속성을 읽지 않게 자기 키만 본다.
export const testsAt = (byId, id) => (byId && Object.hasOwn(byId, id) ? byId[id] : []);

function statusOf(story, tests) {
  const own = testsAt(tests.stories, story.id);
  if (own.length) return own.some((t) => t.status === 'fail') ? 'fail' : own.some((t) => t.status === 'pending') ? 'pending' : 'pass';
  return story.screens.some((id) => testsAt(tests.nodes, id).length) ? 'partial' : 'untested';
}

function unknownStoryTags(stories, tests) {
  const ids = new Set(stories.map((s) => s.id));
  return Object.keys(tests.stories ?? {}).filter((id) => !ids.has(id)).sort(compare).flatMap((id) => {
    const seen = new Set();
    return tests.stories[id].flatMap((t) => {
      const key = `${t.source} ${t.file}:${t.line} ${t.title}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ tag: `story:${id}`, test: { title: t.title, file: t.file, line: t.line } }];
    });
  });
}

function idsInFolder(stories, notices) {
  const unread = notices.filter((n) => n.file.endsWith('.json')).map((n) => path.basename(n.file, '.json')).filter((id) => STORY_ID.test(id));
  return [...new Set([...stories.map((s) => s.id), ...unread])].sort(compare);
}

export const linksWithoutConditions = (map) => map.screens.some((s) => s.links.some((l) => !Array.isArray(l.conditions)));
export const staleMapMessage = (mapFile, what) => `${mapFile} 은 링크에 조건이 없는 예전 duru 로 만든 맵이라 ${what}를 맞춰 보지 못했습니다. duru rebuild 로 맵을 다시 만드세요`;

export function checkStoryFiles(map, dir, mapFile, tests = NO_TESTS) {
  const { stories, notices } = loadStories(dir);
  const unknownTags = unknownStoryTags(stories, tests);
  const ids = idsInFolder(stories, notices);
  if (stories.length && linksWithoutConditions(map)) {
    return { ids, list: [], notices, unknownTags, stale: staleMapMessage(mapFile, '스토리') };
  }
  return { ids, list: checkStories(map, stories).map((s) => ({ ...s, status: statusOf(s, tests) })), notices, unknownTags };
}

export function checkScreens(map, mapFile, screens) {
  if (!isScreenList(screens)) throw new Error('screens 는 화면 ID 를 하나 이상 차례대로 담은 목록이어야 합니다');
  if (linksWithoutConditions(map)) throw new Error(staleMapMessage(mapFile, '스토리'));
  const [checked] = checkStories(map, [{ screens }]);
  const offMap = checked.steps.filter((step) => !step.onMap).map((step) => step.screen);
  if (offMap.length) throw new Error(`맵에 없는 화면입니다: ${offMap.join(', ')}`);
  return checked;
}
