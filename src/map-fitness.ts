import { screenFinder } from './address-match.ts';
import { isCatchAll } from './path-values.ts';
import type { Walks } from './trace-links.ts';

type Screens = { screens: { id: string; path: string }[] };

export const catchAllScreens = (map: Screens) => new Set(map.screens.filter((s) => isCatchAll(s.path)).map((s) => s.id));

const reached = (part: number, whole: number) => whole > 0 && part * 2 >= whole;

export function mapFitnessLine(map: Screens, walks: Walks, records: string[][]): string | null {
  const catchAlls = catchAllScreens(map);
  const screenAt = screenFinder(map);
  const opened = Object.values(walks).flatMap((runs) => Object.values(runs).flat()).flatMap((line) => (line.kind === 'open' ? [line.screen] : []));
  const visited = records.flatMap((addresses) => addresses.filter((a, i) => a !== addresses[i - 1]).map((a) => screenAt(a) ?? undefined));
  const screens = [...opened, ...visited];
  const lost = screens.filter((id) => id === undefined || catchAlls.has(id)).length;
  const unread = map.screens.filter((s) => !s.path.startsWith('/') && !isCatchAll(s.path)).length;
  const fired = [
    ...(reached(lost, screens.length) ? [`${lost} of ${screens.length} addresses opened by browser tests and visit records reached only a catch-all screen or no screen`] : []),
    ...(reached(unread, map.screens.length) ? [`${unread} of ${map.screens.length} screen paths are relative or start with {?}`] : []),
  ];
  return fired.length ? `map not yet fit for story candidates or test matching: ${fired.join('; ')}` : null;
}
