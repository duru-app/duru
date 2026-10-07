const preload = {
  Archive: () => import('../screens/Archive'),
  Profile: () => import('../screens/Profile'),
  Inbox: () => import('../screens/Inbox'),
  Outbox: () => import('../screens/Outbox'),
};

export const preloadPage = (name: keyof typeof preload) => preload[name]();
