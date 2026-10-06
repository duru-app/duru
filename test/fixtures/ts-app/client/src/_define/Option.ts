import type { RouteKey } from './paths';
import { joinPath } from './paths';

function routePaths(base: string): Record<RouteKey, string> {
  return {
    HOME: joinPath(base, 'home'),
    DOCUMENT: joinPath(base, 'document'),
    ADMIN: joinPath(base, 'admin'),
    LAB: joinPath(base, 'lab'),
    REPORT: joinPath(base, 'report'),
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
