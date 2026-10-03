import { linkTargets, unreadableTarget } from './access.mjs';
import { compare } from './config.mjs';
import { loadStories } from './stories.mjs';

const byPlace = (a, b) => compare(a.file, b.file) || a.line - b.line;

export function checkStories(map, stories) {
  const indexOf = new Map(map.screens.map((s, i) => [s.id, i]));
  const targetsOf = linkTargets(map.screens);

  const linkBetween = (fromId, toId) => {
    const from = map.screens[indexOf.get(fromId)];
    const ways = from.links
      .filter((l) => targetsOf(l.to).includes(indexOf.get(toId)))
      .map((l) => ({ file: l.file, line: l.line, conditions: l.conditions }))
      .sort(byPlace);
    // 조건 없는 링크가 하나라도 있으면 빼 둔 링크가 판정을 바꾸지 못하므로 알리지 않는다.
    if (ways.some((w) => !w.conditions.length)) return { verdict: 'open', ways };
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

export function checkStoryFiles(map, dir, mapFile) {
  const { stories, notices } = loadStories(dir);
  if (stories.length && map.screens.some((s) => s.links.some((l) => !Array.isArray(l.conditions)))) {
    return { list: [], notices, stale: `${mapFile} 은 링크에 조건이 없는 예전 duru 로 만든 맵이라 스토리를 맞춰 보지 못했습니다. duru rebuild 로 맵을 다시 만드세요` };
  }
  return { list: checkStories(map, stories), notices };
}
