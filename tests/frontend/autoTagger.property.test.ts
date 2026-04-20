import * as fc from 'fast-check';
import {
  normalizeTagName,
  findExistingTag,
  mapPredictedTags,
} from '../../src/frontend/image/tagMapper';

// Feature: image-auto-tagging, Property 8: Tag mapping normalizes names and avoids duplicates

/**
 * **Validates: Requirements 8.1, 8.3, 8.4**
 *
 * Property 8: For any predicted tag name and any existing tag store state,
 * the tag mapping function should:
 * (a) replace all underscores in the tag name with spaces
 * (b) find an existing tag via case-insensitive comparison if one exists
 *     (and not create a new one)
 * (c) create a new tag under root only if no case-insensitive match exists
 * After mapping, the tag store should contain exactly one tag matching the
 * normalized name (no duplicates).
 */
describe('Property 8: Tag mapping normalizes names and avoids duplicates', () => {
  // Generator: tag names with underscores and mixed case (1-20 chars of letters and underscores)
  const tagNameArb = fc.stringMatching(/^[a-zA-Z_]{1,20}$/).filter((s) => s.length > 0);

  // Generator: existing tag names (human-readable, with spaces and mixed case)
  const existingTagNameArb = fc
    .stringMatching(/^[a-zA-Z ]{1,20}$/)
    .filter((s) => s.trim().length > 0);

  // Generator: list of existing tag names
  const existingTagListArb = fc.array(existingTagNameArb, { minLength: 0, maxLength: 20 });

  // Generator: list of predicted tag names
  const predictedTagListArb = fc.array(tagNameArb, { minLength: 1, maxLength: 20 });

  describe('normalizeTagName', () => {
    it('replaces all underscores with spaces', () => {
      fc.assert(
        fc.property(tagNameArb, (name) => {
          const normalized = normalizeTagName(name);
          // No underscores should remain
          return !normalized.includes('_');
        }),
        { numRuns: 100 },
      );
    });

    it('only replaces underscores — other characters are preserved', () => {
      fc.assert(
        fc.property(tagNameArb, (name) => {
          const normalized = normalizeTagName(name);
          // Every non-underscore character should be preserved in order
          const originalWithoutUnderscores = name.replace(/_/g, '');
          const normalizedWithoutSpaces = normalized.replace(/ /g, '');
          return originalWithoutUnderscores === normalizedWithoutSpaces;
        }),
        { numRuns: 100 },
      );
    });

    it('number of spaces in result equals number of underscores in input (plus original spaces)', () => {
      fc.assert(
        fc.property(tagNameArb, (name) => {
          const normalized = normalizeTagName(name);
          const underscoreCount = (name.match(/_/g) || []).length;
          const originalSpaceCount = (name.match(/ /g) || []).length;
          const resultSpaceCount = (normalized.match(/ /g) || []).length;
          return resultSpaceCount === underscoreCount + originalSpaceCount;
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('findExistingTag', () => {
    it('finds a match case-insensitively when one exists', () => {
      fc.assert(
        fc.property(
          existingTagNameArb,
          fc.constantFrom('lower', 'upper', 'mixed'),
          (tagName, caseVariant) => {
            const tagList = [{ name: tagName }];

            // Create a case variant of the name to search for
            let searchName: string;
            switch (caseVariant) {
              case 'lower':
                searchName = tagName.toLowerCase();
                break;
              case 'upper':
                searchName = tagName.toUpperCase();
                break;
              case 'mixed':
                searchName = tagName
                  .split('')
                  .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
                  .join('');
                break;
              default:
                searchName = tagName;
            }

            const result = findExistingTag(searchName, tagList);
            // Should find the tag regardless of case
            return result !== undefined && result.name === tagName;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns undefined when no match exists', () => {
      fc.assert(
        fc.property(existingTagListArb, (existingNames) => {
          const tagList = existingNames.map((name) => ({ name }));
          // Use a name that cannot match any existing tag
          const searchName = '$$NOMATCH$$';
          const result = findExistingTag(searchName, tagList);
          return result === undefined;
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('mapPredictedTags — full mapping', () => {
    it('all normalized names have no underscores', () => {
      fc.assert(
        fc.property(predictedTagListArb, existingTagListArb, (predicted, existing) => {
          const { results } = mapPredictedTags(predicted, existing);
          return results.every((r) => !r.normalizedName.includes('_'));
        }),
        { numRuns: 100 },
      );
    });

    it('case-insensitive match finds existing tag (isExisting is true)', () => {
      fc.assert(
        fc.property(
          existingTagNameArb,
          fc.constantFrom('lower', 'upper', 'mixed'),
          (existingName, caseVariant) => {
            // Create a predicted name that, after normalization, matches the existing tag
            // Replace spaces with underscores to simulate model output
            const predictedBase = existingName.replace(/ /g, '_');

            let predicted: string;
            switch (caseVariant) {
              case 'lower':
                predicted = predictedBase.toLowerCase();
                break;
              case 'upper':
                predicted = predictedBase.toUpperCase();
                break;
              case 'mixed':
                predicted = predictedBase
                  .split('')
                  .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
                  .join('');
                break;
              default:
                predicted = predictedBase;
            }

            const { results } = mapPredictedTags([predicted], [existingName]);
            return results.length === 1 && results[0].isExisting === true;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('new tag created only when no case-insensitive match exists', () => {
      fc.assert(
        fc.property(predictedTagListArb, existingTagListArb, (predicted, existing) => {
          const existingLower = new Set(existing.map((n) => n.toLowerCase()));
          const { results } = mapPredictedTags(predicted, existing);

          // Track newly created tags during mapping (same as mapPredictedTags does internally)
          const createdDuringMapping = new Set<string>();

          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const lowerNorm = r.normalizedName.toLowerCase();

            if (existingLower.has(lowerNorm) || createdDuringMapping.has(lowerNorm)) {
              // Should be marked as existing
              if (!r.isExisting) return false;
            } else {
              // Should be marked as new
              if (r.isExisting) return false;
              createdDuringMapping.add(lowerNorm);
            }
          }
          return true;
        }),
        { numRuns: 100 },
      );
    });

    it('no duplicate tag names in final tag set (case-insensitive)', () => {
      fc.assert(
        fc.property(predictedTagListArb, existingTagListArb, (predicted, existing) => {
          const { finalTagNames } = mapPredictedTags(predicted, existing);
          const lowerNames = finalTagNames.map((n) => n.toLowerCase());
          const uniqueLower = new Set(lowerNames);
          return uniqueLower.size === lowerNames.length;
        }),
        { numRuns: 100 },
      );
    });

    it('every predicted tag has exactly one match in the final tag set', () => {
      fc.assert(
        fc.property(predictedTagListArb, existingTagListArb, (predicted, existing) => {
          const { results, finalTagNames } = mapPredictedTags(predicted, existing);
          const finalLower = finalTagNames.map((n) => n.toLowerCase());

          for (const r of results) {
            const matchCount = finalLower.filter(
              (n) => n === r.normalizedName.toLowerCase(),
            ).length;
            if (matchCount !== 1) return false;
          }
          return true;
        }),
        { numRuns: 100 },
      );
    });
  });
});

// Feature: image-auto-tagging, Property 9: Bulk auto-tagging processes all files despite individual failures

import { bulkProcess } from '../../src/frontend/image/bulkProcessor';

/**
 * **Validates: Requirements 11.4**
 *
 * Property 9: For any list of files where some random subset will fail
 * inference (throw an error), the bulk processing function should:
 * (a) attempt to process every file in the list
 * (b) report a final attempted count equal to the total number of files
 * (c) track the number of errors that occurred
 * (d) invoke the progress callback for every item processed
 */
describe('Property 9: Bulk auto-tagging processes all files despite individual failures', () => {
  // Generator: a list of items (1–50) paired with a boolean mask indicating which items fail
  const itemsWithFailuresArb = fc
    .array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 50 })
    .chain((items) =>
      fc
        .array(fc.boolean(), { minLength: items.length, maxLength: items.length })
        .map((failMask) => ({ items, failMask })),
    );

  /** Build a processItem function that throws for indices marked true in failMask */
  function makeProcessor(failMask: boolean[]) {
    let callIndex = 0;
    return async (_item: number): Promise<void> => {
      const idx = callIndex++;
      if (failMask[idx]) {
        throw new Error(`Simulated failure at index ${idx}`);
      }
    };
  }

  it('attempted count equals total number of items regardless of failures', async () => {
    await fc.assert(
      fc.asyncProperty(itemsWithFailuresArb, async ({ items, failMask }) => {
        const result = await bulkProcess(items, makeProcessor(failMask));
        return result.attempted === items.length;
      }),
      { numRuns: 100 },
    );
  });

  it('error count matches the number of items that threw', async () => {
    await fc.assert(
      fc.asyncProperty(itemsWithFailuresArb, async ({ items, failMask }) => {
        const result = await bulkProcess(items, makeProcessor(failMask));
        const expectedErrors = failMask.filter(Boolean).length;
        return result.errors === expectedErrors;
      }),
      { numRuns: 100 },
    );
  });

  it('progress callback is invoked for every item with correct counts', async () => {
    await fc.assert(
      fc.asyncProperty(itemsWithFailuresArb, async ({ items, failMask }) => {
        const progressCalls: Array<{ processed: number; total: number }> = [];

        const onProgress = (processed: number, total: number) => {
          progressCalls.push({ processed, total });
        };

        await bulkProcess(items, makeProcessor(failMask), onProgress);

        // Progress should be called once per item
        if (progressCalls.length !== items.length) return false;

        // Each call should have incrementing processed count and correct total
        for (let i = 0; i < progressCalls.length; i++) {
          if (progressCalls[i].processed !== i + 1) return false;
          if (progressCalls[i].total !== items.length) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('all items are attempted even when all fail', async () => {
    const itemListArb = fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 50 });

    await fc.assert(
      fc.asyncProperty(itemListArb, async (items) => {
        const processItem = async (_item: number): Promise<void> => {
          throw new Error('All items fail');
        };

        const result = await bulkProcess(items, processItem);
        return result.attempted === items.length && result.errors === items.length;
      }),
      { numRuns: 100 },
    );
  });

  it('zero errors when no items fail', async () => {
    const itemListArb = fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 50 });

    await fc.assert(
      fc.asyncProperty(itemListArb, async (items) => {
        const processItem = async (_item: number): Promise<void> => {
          // No-op: success
        };

        const result = await bulkProcess(items, processItem);
        return result.attempted === items.length && result.errors === 0;
      }),
      { numRuns: 100 },
    );
  });
});
