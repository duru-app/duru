import { lazy } from 'react';

const loadPage = {
  Archive: () => import('../screens/Archive'),
  Profile: () => import('../screens/Profile'),
};

export const LazyPage = {
  Archive: lazy(loadPage.Archive),
  Profile: lazy(loadPage.Profile),
} satisfies Record<keyof typeof loadPage, unknown>;
