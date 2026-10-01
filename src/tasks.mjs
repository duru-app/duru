import path from 'node:path';
import { reviewData } from './review.mjs';
import { DEPTHS } from './test-links.mjs';

const OPEN = ['needs-more', 'missing'];
const KIND_NAMES = { setting: 'a setting', role: 'a role' };

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const guardText = (g) => `\`${g.guard}\`${g.via ? ` through ${g.via}` : ''} (${g.kinds.join(', ')})`;

const optionText = (o) => `${o.key}=${o.value}`;

function cellText({ option, depth }, whole) {
  if (!option) return depth ? `${depth} depth` : whole;
  return depth ? `${optionText(option)} at ${depth} depth` : optionText(option);
}

function markLine(mark, whole) {
  const where = cellText(mark.target, whole);
  const note = mark.note ? ` — "${mark.note.replace(/\r?\n/g, '\n    ')}"` : '';
  return `  - ${mark.status}, ${where}${note} (${mark.author}, ${mark.date.slice(0, 10)})`;
}

const kindsText = (kinds) => kinds.map((k) => KIND_NAMES[k]).join(' and ');

function accessLines(access) {
  if (!access.restricted) return ['- access: opens without a setting or role'];
  return [
    `- access: needs ${kindsText(access.kinds)}`,
    ...access.route.map((g) => `  - route guard ${guardText(g)}`),
    ...access.links.map((l) => {
      const from = `  - link from ${l.from} at ${l.file}:${l.line}`;
      const guards = l.guards.length ? `guard ${l.guards.map(guardText).join('; ')}` : 'no guard';
      return `${from}, ${guards}${l.fromKinds.length ? ` — ${l.from} itself needs ${kindsText(l.fromKinds)}` : ''}`;
    }),
  ];
}

const byDepth = (tests) => [...tests].sort((a, b) => DEPTHS.indexOf(a.depth) - DEPTHS.indexOf(b.depth));

function testSummary(tests) {
  if (!tests?.length) return 'no tests';
  const counts = new Map();
  for (const t of byDepth(tests)) counts.set(`${t.depth} ${t.status}`, (counts.get(`${t.depth} ${t.status}`) ?? 0) + 1);
  return 'tests: ' + [...counts].map(([k, n]) => `${k} ${n}`).join(', ');
}

const withOption = (tests, { key, value }) => (tests ?? []).filter((t) => t.options?.some((o) => o.key === key && o.value === value));

function optionLines(keys, tests) {
  const rows = keys.flatMap((key) => [true, false].map((value) => [optionText({ key, value }), withOption(tests, { key, value })]));
  rows.push(['no option tag', tests.filter((t) => !t.options?.length)]);
  return rows.map(([label, matching]) => `    - ${label} — ${testSummary(matching)}`);
}

function callLines(screen, tests) {
  const seen = new Set();
  const lines = [];
  for (const call of screen.apiCalls) {
    if (!call.endpoints) {
      lines.push(`  - ${call.fn} at ${call.file}:${call.line} — not found among the API functions`);
      continue;
    }
    for (const e of call.endpoints) {
      if (!e.callId) {
        lines.push(`  - ${call.fn} at ${call.file}:${call.line} — address not resolved`);
        continue;
      }
      if (seen.has(e.callId)) continue;
      seen.add(e.callId);
      const server = e.server.status === 'none' ? 'not on the server, ' : '';
      const options = screen.callOptions[e.callId].map((o) => o.key);
      lines.push(`  - ${e.callId} — ${server}${testSummary(tests[e.callId])}${options.length ? ` — options: ${options.join(', ')}` : ''}`);
      if (options.length) lines.push(...optionLines(options, tests[e.callId] ?? []));
    }
  }
  return lines.length ? ['- calls:', ...lines] : ['- calls: none'];
}

function testLine(t) {
  const at = t.line ? `${t.file}:${t.line}` : t.file;
  const detail = t.detail ? ` — ${t.detail}` : '';
  return `- ${t.depth} ${t.status} — ${t.title} — ${at}${t.project ? ` (${t.project})` : ''}${detail}`;
}

function testLines(tests) {
  if (!tests?.length) return ['- tests: none'];
  return ['- tests:', ...byDepth(tests).map((t) => `  ${testLine(t)}`)];
}

function optionSource(option) {
  const sites = new Map();
  for (const s of option.sites) {
    const at = `${s.file}:${s.line}`;
    sites.set(at, [...(sites.get(at) ?? []), s.screen]);
  }
  const found = [...sites].map(([at, screens]) => `${at} (${screens.join(', ')})`).join('; ');
  const config = option.sources.includes('config');
  if (!found) return 'set in the config, not found in the source';
  return `found at ${found}${config ? '; also set in the config' : ''}`;
}

function markedOptionLines(call, marks, tests) {
  const targets = marks.map((m) => m.target).filter((t) => t.option);
  if (!targets.length) return [];
  const lines = ['- marked options:'];
  for (const option of call.options) {
    const cells = targets
      .filter((t) => t.option.key === option.key)
      .sort((a, b) => Number(b.option.value) - Number(a.option.value) || DEPTHS.indexOf(a.depth) - DEPTHS.indexOf(b.depth));
    if (!cells.length) continue;
    lines.push(`  - ${option.key} — ${optionSource(option)}`);
    for (const t of cells) {
      const matching = withOption(tests, t.option).filter((x) => !t.depth || x.depth === t.depth);
      const label = `    - ${cellText(t)}:`;
      lines.push(...(matching.length ? [label, ...byDepth(matching).map((x) => `      ${testLine(x)}`)] : [`${label} no tests`]));
    }
  }
  return lines;
}

function serverText(server) {
  if (server.status === 'match') return `on the server (${server.labels.join(', ')})`;
  if (server.status === 'method-mismatch') return `method mismatch — the server has ${server.candidates.join('; ')}`;
  return 'not on the server';
}

export function taskList(config) {
  const { map, tests, marks, appLinks } = reviewData(config, null);
  const open = marks.attached.filter((m) => OPEN.includes(m.current.status));
  const marked = (node) => open.some((m) => m.target.node === node.id);
  const screens = map.screens.filter(marked).sort((a, b) => a.id.localeCompare(b.id));
  const calls = map.calls.filter(marked);

  const out = [
    `# Test tasks — ${count(screens.length, 'screen')}, ${count(calls.length, 'call')}, ${count(open.length, 'open mark')}`,
    '',
    `A reviewer marked these screens and API calls as needing more tests (\`needs-more\`) or as having none (\`missing\`). Write the tests, put \`@screen:<screen ID>\` in each test title (\`@call:<call ID>\` for a test of one API call, with \`@option:<key>=true|false\` for each on/off option the test sets), add \`@depth:<${DEPTHS.join('|')}>\` when the depth of the result source does not fit, then run \`duru rebuild\` and read this list again. A screen or call stays here until a reviewer marks it \`fine\`.`,
    '',
    `Source files are under \`${path.relative(config.configDir, config.srcRoot).split(path.sep).join('/')}\`.`,
  ];
  if (!open.length) out.push('', 'No open marks.');
  for (const s of screens) {
    out.push(
      '',
      `## ${s.id}`,
      '',
      '- marks:',
      ...open.filter((m) => m.target.node === s.id).map((m) => markLine(m.current, 'whole screen')),
      `- component: ${s.componentFile}, route at ${config.routesFile}:${s.line}`,
      ...(appLinks[s.id] ? [`- app: ${appLinks[s.id]}`] : []),
      ...accessLines(s.access),
      ...callLines(s, tests.nodes),
      ...testLines(tests.nodes[s.id]),
    );
  }
  if (calls.length) out.push('', '# API calls');
  for (const c of calls) {
    const marks = open.filter((m) => m.target.node === c.id);
    out.push(
      '',
      `## ${c.id}`,
      '',
      '- marks:',
      ...marks.map((m) => markLine(m.current, 'whole call')),
      `- called from: ${c.screens.length ? c.screens.join(', ') : 'no screen'}`,
      `- server: ${serverText(c.server)}`,
      ...markedOptionLines(c, marks, tests.nodes[c.id]),
      ...testLines(tests.nodes[c.id]),
    );
  }
  return out.join('\n') + '\n';
}
