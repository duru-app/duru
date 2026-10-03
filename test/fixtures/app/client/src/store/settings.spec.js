import { defaults } from './settings';

test('the lab is off by default', () => {
  expect(defaults.SYSTEM.LAB_ENABLED).toBe(false);
});
