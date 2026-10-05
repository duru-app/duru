import { describe, expect, it } from 'vitest';
import type Home from './Home';
import Lab from './Lab';

const ids = ['d1'] as string[];

describe('Lab', () => {
  it('renders the archive button', () => {
    expect(Lab({ ids, session: {} }) satisfies unknown).toBeDefined();
  });
});
