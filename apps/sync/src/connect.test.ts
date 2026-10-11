import { expect, it } from 'vitest';
import { validState } from './connect.js';

it('OAuth stateの欠落・長さ違い・値違いを拒否する', () => {
  expect(validState(null, 'expected')).toBe(false);
  expect(validState('short', 'expected')).toBe(false);
  expect(validState('expectee', 'expected')).toBe(false);
  expect(validState('expected', 'expected')).toBe(true);
});
