export default {
  ROUTE_PATH: {
    HOME: '/home',
    DOCUMENT: '/document',
    ADMIN: '/admin',
    LAB: '/lab',
    REPORT: '/report',
  },
  REST_API: {
    REPORT: {
      ARCHIVE: { METHOD: 'POST', URL: '/api/v1/report/archive' },
      SCHEDULE: { METHOD: 'POST', URL: '/api/v1/report/schedule' },
    },
  },
};
