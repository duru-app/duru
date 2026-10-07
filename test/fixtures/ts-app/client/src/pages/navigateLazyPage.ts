import type { NavigateFunction } from 'react-router-dom';
import { preloadPage } from './preloadPages';

export async function navigateLazyPage(navigate: NavigateFunction, page: Parameters<typeof preloadPage>[0], to: string) {
  await preloadPage(page);
  navigate(to);
}
