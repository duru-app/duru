import type { RouteKey } from './paths';
import { joinPath } from './paths';

enum Segment {
  Home = 'home',
  Document = 'document',
}

namespace Section {
  export const ADMIN = 'admin';
  export namespace Tools {
    export const LAB = 'lab';
  }
}

function routePaths(base: string): Record<RouteKey, string> {
  return {
    HOME: joinPath(base, Segment.Home),
    DOCUMENT: joinPath(base, Segment.Document),
    ADMIN: joinPath(base, Section.ADMIN),
    LAB: joinPath(base, Section.Tools.LAB),
    REPORT: joinPath(base, 'report'),
    ARCHIVE: joinPath(base, 'archive'),
    PROFILE: joinPath(base, 'profile'),
    INBOX: joinPath(base, 'inbox'),
    OUTBOX: joinPath(base, 'outbox'),
  };
}

export default {
  ROUTE_PATH: routePaths(''),
  REST_API: {
    REPORT: {
      ARCHIVE: { METHOD: 'POST', URL: '/api/v1/report/archive' },
      SCHEDULE: { METHOD: 'POST', URL: '/api/v1/report/schedule' },
    },
  } as const,
};
