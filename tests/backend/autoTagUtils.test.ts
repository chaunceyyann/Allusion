import { sigmoid, filterAndSortTags } from '../../src/backend/autoTagUtils';
import { PredictedTag } from '../../src/backend/autoTagTypes';

describe('sigmoid', () => {
  it('returns 0.5 for input 0', () => {
    expect(sigmoid(0)).toBe(0.5);
  });

  it('returns values in (0, 1) for positive inputs', () => {
    expect(sigmoid(1)).toBeGreaterThan(0);
    expect(sigmoid(1)).toBeLessThan(1);
    expect(sigmoid(10)).toBeGreaterThan(0);
    expect(sigmoid(10)).toBeLessThan(1);
  });

  it('returns values in (0, 1) for negative inputs', () => {
    expect(sigmoid(-1)).toBeGreaterThan(0);
    expect(sigmoid(-1)).toBeLessThan(1);
    expect(sigmoid(-10)).toBeGreaterThan(0);
    expect(sigmoid(-10)).toBeLessThan(1);
  });

  it('satisfies the symmetry property: sigmoid(-x) ≈ 1 - sigmoid(x)', () => {
    for (const x of [0.5, 1, 2, 5, 10]) {
      expect(sigmoid(-x)).toBeCloseTo(1 - sigmoid(x), 10);
    }
  });

  it('approaches 1 for large positive inputs', () => {
    expect(sigmoid(100)).toBeCloseTo(1, 5);
  });

  it('approaches 0 for large negative inputs', () => {
    expect(sigmoid(-100)).toBeCloseTo(0, 5);
  });
});

describe('filterAndSortTags', () => {
  const makeTags = (...entries: [string, PredictedTag['category'], number][]): PredictedTag[] =>
    entries.map(([name, category, score]) => ({ name, category, score }));

  it('retains general tags meeting the threshold', () => {
    const tags = makeTags(['cat', 'general', 0.5], ['dog', 'general', 0.2]);
    const result = filterAndSortTags(tags, 0.3, 0.5);
    expect(result).toEqual([{ name: 'cat', category: 'general', score: 0.5 }]);
  });

  it('retains character tags meeting the threshold', () => {
    const tags = makeTags(['hatsune_miku', 'character', 0.8], ['rem', 'character', 0.3]);
    const result = filterAndSortTags(tags, 0.25, 0.5);
    expect(result).toEqual([{ name: 'hatsune_miku', category: 'character', score: 0.8 }]);
  });

  it('excludes all rating tags regardless of score', () => {
    const tags = makeTags(
      ['safe', 'rating', 0.99],
      ['explicit', 'rating', 0.8],
      ['cat', 'general', 0.5],
    );
    const result = filterAndSortTags(tags, 0.25, 0.5);
    expect(result).toEqual([{ name: 'cat', category: 'general', score: 0.5 }]);
  });

  it('sorts results by score in descending order', () => {
    const tags = makeTags(
      ['a', 'general', 0.3],
      ['b', 'general', 0.9],
      ['c', 'general', 0.6],
      ['d', 'character', 0.7],
    );
    const result = filterAndSortTags(tags, 0.25, 0.5);
    expect(result.map((t) => t.score)).toEqual([0.9, 0.7, 0.6, 0.3]);
  });

  it('returns empty array when no tags meet thresholds', () => {
    const tags = makeTags(['a', 'general', 0.1], ['b', 'character', 0.2]);
    const result = filterAndSortTags(tags, 0.5, 0.5);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(filterAndSortTags([], 0.25, 0.5)).toEqual([]);
  });

  it('includes tags exactly at the threshold boundary', () => {
    const tags = makeTags(['a', 'general', 0.25], ['b', 'character', 0.5]);
    const result = filterAndSortTags(tags, 0.25, 0.5);
    expect(result).toHaveLength(2);
  });
});
