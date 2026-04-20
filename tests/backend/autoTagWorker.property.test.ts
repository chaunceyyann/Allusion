import * as fc from 'fast-check';
import { sigmoid, filterAndSortTags } from '../../src/backend/autoTagUtils';
import { PredictedTag } from '../../src/backend/autoTagTypes';

// Feature: image-auto-tagging, Property 5: Sigmoid activation produces valid probabilities

/**
 * **Validates: Requirements 5.2**
 *
 * Property 5: For any finite floating-point number x, sigmoid(x) should satisfy:
 * (a) the result is in the open interval (0, 1)
 * (b) sigmoid(0) = 0.5
 * (c) sigmoid(-x) ≈ 1 - sigmoid(x) (symmetry property)
 *
 * Note: The float range is constrained to [-36, 36] for the strict (0, 1) check
 * because IEEE 754 double precision causes sigmoid to saturate to exactly 0.0 or
 * 1.0 for |x| >= ~37 (Math.exp(-x) underflows/overflows). This is inherent to
 * floating-point arithmetic, not a bug in the implementation.
 */
describe('Property 5: Sigmoid activation produces valid probabilities', () => {
  it('sigmoid(x) is in the open interval (0, 1) for any finite float', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -36, max: 36, noNaN: true, noDefaultInfinity: true }),
        (x) => {
          const result = sigmoid(x);
          return result > 0 && result < 1;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sigmoid(0) equals 0.5', () => {
    expect(sigmoid(0)).toBe(0.5);
  });

  it('sigmoid(-x) ≈ 1 - sigmoid(x) for any finite float (symmetry)', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        (x) => {
          const left = sigmoid(-x);
          const right = 1 - sigmoid(x);
          return Math.abs(left - right) < 1e-10;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: image-auto-tagging, Property 6: Tag filtering respects thresholds, excludes ratings, and preserves sort order

/**
 * **Validates: Requirements 5.3, 5.4, 5.6, 5.7**
 *
 * Property 6: For any array of scored tag entries (each with a name, category,
 * and score in [0, 1]), any general threshold, and any character threshold, the
 * filtering function should return a result where:
 * (a) every retained general tag has score >= generalThreshold
 * (b) every retained character tag has score >= characterThreshold
 * (c) no tag with category 'rating' is present
 * (d) the result is sorted by score in descending order
 */
describe('Property 6: Tag filtering respects thresholds, excludes ratings, and preserves sort order', () => {
  const categoryArb: fc.Arbitrary<'general' | 'character' | 'rating'> = fc.constantFrom(
    'general' as const,
    'character' as const,
    'rating' as const,
  );

  const predictedTagArb: fc.Arbitrary<PredictedTag> = fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 30 }),
      category: categoryArb,
      score: fc.double({ min: 0, max: 1, noNaN: true }),
    })
    .map((r) => r as PredictedTag);

  const tagsArb = fc.array(predictedTagArb, { minLength: 0, maxLength: 50 });
  const thresholdArb = fc.double({ min: 0, max: 1, noNaN: true });

  it('every retained general tag has score >= generalThreshold', () => {
    fc.assert(
      fc.property(tagsArb, thresholdArb, thresholdArb, (tags, generalThreshold, characterThreshold) => {
        const result = filterAndSortTags(tags, generalThreshold, characterThreshold);
        return result
          .filter((t) => t.category === 'general')
          .every((t) => t.score >= generalThreshold);
      }),
      { numRuns: 100 },
    );
  });

  it('every retained character tag has score >= characterThreshold', () => {
    fc.assert(
      fc.property(tagsArb, thresholdArb, thresholdArb, (tags, generalThreshold, characterThreshold) => {
        const result = filterAndSortTags(tags, generalThreshold, characterThreshold);
        return result
          .filter((t) => t.category === 'character')
          .every((t) => t.score >= characterThreshold);
      }),
      { numRuns: 100 },
    );
  });

  it('no tag with category rating is present in the result', () => {
    fc.assert(
      fc.property(tagsArb, thresholdArb, thresholdArb, (tags, generalThreshold, characterThreshold) => {
        const result = filterAndSortTags(tags, generalThreshold, characterThreshold);
        return result.every((t) => t.category !== 'rating');
      }),
      { numRuns: 100 },
    );
  });

  it('result is sorted by score in descending order', () => {
    fc.assert(
      fc.property(tagsArb, thresholdArb, thresholdArb, (tags, generalThreshold, characterThreshold) => {
        const result = filterAndSortTags(tags, generalThreshold, characterThreshold);
        for (let i = 0; i < result.length - 1; i++) {
          if (result[i].score < result[i + 1].score) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: image-auto-tagging, Property 3: Tag CSV parsing round-trip preserves tag mappings

import { parseTagCsvContent } from '../../src/backend/autoTagUtils';
import { TagMapping } from '../../src/backend/autoTagTypes';

/**
 * **Validates: Requirements 2.5**
 *
 * Property 3: For any valid Tag CSV content containing rows with index, name,
 * and category fields, parsing the CSV should produce an ordered array where
 * the entry at each index has the correct tag name and category label
 * (general, character, or rating), and the array length equals the number of
 * rows in the CSV.
 */
describe('Property 3: Tag CSV parsing round-trip preserves tag mappings', () => {
  // Valid category codes and their expected string labels
  const categoryCodeArb = fc.constantFrom(0, 4, 9);

  function categoryCodeToLabel(code: number): 'general' | 'character' | 'rating' {
    switch (code) {
      case 0:
        return 'general';
      case 4:
        return 'character';
      case 9:
        return 'rating';
      default:
        return 'general';
    }
  }

  // Generate a single tag entry with a name and category code (index assigned later)
  const tagEntryArb = fc.record({
    name: fc.stringMatching(/^[a-zA-Z0-9_]+$/).filter((s) => s.length > 0),
    categoryCode: categoryCodeArb,
  });

  // Generate an array of tag entries; indices are assigned sequentially after generation
  const tagEntriesArb = fc
    .array(tagEntryArb, { minLength: 1, maxLength: 30 })
    .map((entries) => entries.map((e, i) => ({ index: i, ...e })));

  /**
   * Serializes tag entries into CSV format (no header) and parses them back.
   * Verifies the parsed array length equals the input row count and each
   * entry has the correct name and category.
   */
  it('parsed array length equals row count and entries match input', () => {
    fc.assert(
      fc.property(tagEntriesArb, (entries) => {
        // Serialize to CSV string (no header)
        const csvLines = entries.map(
          (e) => `${e.index},${e.name},${e.categoryCode}`,
        );
        const csvContent = csvLines.join('\n');

        const result = parseTagCsvContent(csvContent);

        // Length must match
        if (result.length !== entries.length) {
          return false;
        }

        // Each entry must have the correct name and category
        for (let i = 0; i < entries.length; i++) {
          const expected = entries[i];
          const actual = result[i];
          if (actual.name !== expected.name) return false;
          if (actual.category !== categoryCodeToLabel(expected.categoryCode)) return false;
          if (actual.index !== expected.index) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Verifies that a header row (containing "tag_id" or "name") is correctly
   * skipped and does not appear in the parsed output.
   */
  it('header row is skipped when present', () => {
    fc.assert(
      fc.property(tagEntriesArb, (entries) => {
        const header = 'tag_id,name,category,count';
        const csvLines = entries.map(
          (e) => `${e.index},${e.name},${e.categoryCode}`,
        );
        const csvContent = [header, ...csvLines].join('\n');

        const result = parseTagCsvContent(csvContent);

        // Length must match entries (header excluded)
        if (result.length !== entries.length) {
          return false;
        }

        for (let i = 0; i < entries.length; i++) {
          const expected = entries[i];
          const actual = result[i];
          if (actual.name !== expected.name) return false;
          if (actual.category !== categoryCodeToLabel(expected.categoryCode)) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: image-auto-tagging, Property 4: Preprocessor output invariants

import { preprocessImage } from '../../src/backend/autoTagUtils';
import * as sharp from 'sharp';

/**
 * **Validates: Requirements 4.2, 4.3**
 *
 * Property 4: For any valid image (of any supported dimensions and format),
 * the preprocessor should produce a Float32Array of length exactly
 * 1 × 448 × 448 × 3 = 602112, where every value is in the range [0.0, 255.0].
 *
 * We use sharp to generate test images of random dimensions and RGB backgrounds
 * programmatically, avoiding the need for actual image files on disk.
 */
describe('Property 4: Preprocessor output invariants', () => {
  const EXPECTED_LENGTH = 1 * 448 * 448 * 3; // 602112

  // Arbitraries for image generation
  const widthArb = fc.integer({ min: 1, max: 2000 });
  const heightArb = fc.integer({ min: 1, max: 2000 });
  const channelValueArb = fc.integer({ min: 0, max: 255 });

  it('output tensor length is exactly 602112 for any image dimensions', async () => {
    await fc.assert(
      fc.asyncProperty(
        widthArb,
        heightArb,
        channelValueArb,
        channelValueArb,
        channelValueArb,
        async (width, height, r, g, b) => {
          // Generate a test image buffer using sharp
          const imageBuffer = await sharp({
            create: {
              width,
              height,
              channels: 3,
              background: { r, g, b },
            },
          })
            .png()
            .toBuffer();

          const result = await preprocessImage(imageBuffer);

          expect(result.tensor).toBeInstanceOf(Float32Array);
          expect(result.tensor.length).toBe(EXPECTED_LENGTH);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('all tensor values are in the range [0.0, 255.0]', async () => {
    await fc.assert(
      fc.asyncProperty(
        widthArb,
        heightArb,
        channelValueArb,
        channelValueArb,
        channelValueArb,
        async (width, height, r, g, b) => {
          const imageBuffer = await sharp({
            create: {
              width,
              height,
              channels: 3,
              background: { r, g, b },
            },
          })
            .png()
            .toBuffer();

          const result = await preprocessImage(imageBuffer);

          for (let i = 0; i < result.tensor.length; i++) {
            const val = result.tensor[i];
            if (val < 0.0 || val > 255.0) {
              return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 20 },
    );
  });

  it('output width and height are always 448', async () => {
    await fc.assert(
      fc.asyncProperty(
        widthArb,
        heightArb,
        channelValueArb,
        channelValueArb,
        channelValueArb,
        async (width, height, r, g, b) => {
          const imageBuffer = await sharp({
            create: {
              width,
              height,
              channels: 3,
              background: { r, g, b },
            },
          })
            .png()
            .toBuffer();

          const result = await preprocessImage(imageBuffer);

          expect(result.width).toBe(448);
          expect(result.height).toBe(448);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// Feature: image-auto-tagging, Property 7: Caption file parsing trims whitespace and splits correctly

import { parseCaptionContent } from '../../src/backend/autoTagUtils';

/**
 * **Validates: Requirements 6.5**
 *
 * Property 7: For any comma-separated string (including strings with
 * leading/trailing whitespace around entries, empty entries, and multiple
 * commas), parsing should produce an array where every element has no
 * leading or trailing whitespace and no element is the empty string.
 */
describe('Property 7: Caption file parsing trims whitespace and splits correctly', () => {
  // Generator: random tag-like strings (non-empty, may contain inner spaces)
  const tagWordArb = fc.stringMatching(/^[a-zA-Z0-9_ ]{1,20}$/);

  // Generator: whitespace variations (spaces, tabs)
  const whitespaceArb = fc
    .array(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 5 })
    .map((chars) => chars.join(''));

  // Generator: a single entry with optional surrounding whitespace
  const paddedEntryArb = fc.tuple(whitespaceArb, tagWordArb, whitespaceArb).map(
    ([pre, word, post]) => `${pre}${word}${post}`,
  );

  // Generator: comma-separated string with whitespace variations
  const commaSeparatedArb = fc
    .array(paddedEntryArb, { minLength: 0, maxLength: 20 })
    .map((entries) => entries.join(','));

  it('every element in the result has no leading or trailing whitespace', () => {
    fc.assert(
      fc.property(commaSeparatedArb, (input) => {
        const result = parseCaptionContent(input);
        return result.every((tag) => tag === tag.trim());
      }),
      { numRuns: 100 },
    );
  });

  it('no element in the result is the empty string', () => {
    fc.assert(
      fc.property(commaSeparatedArb, (input) => {
        const result = parseCaptionContent(input);
        return result.every((tag) => tag.length > 0);
      }),
      { numRuns: 100 },
    );
  });

  it('handles strings with multiple consecutive commas (empty entries filtered out)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(paddedEntryArb, whitespaceArb),
          { minLength: 0, maxLength: 20 },
        ).map((entries) => entries.join(',')),
        (input) => {
          const result = parseCaptionContent(input);
          return result.every((tag) => tag.length > 0 && tag === tag.trim());
        },
      ),
      { numRuns: 100 },
    );
  });

  it('handles strings with leading/trailing commas', () => {
    fc.assert(
      fc.property(
        commaSeparatedArb.map((s) => `,${s},`),
        (input) => {
          const result = parseCaptionContent(input);
          return result.every((tag) => tag.length > 0 && tag === tag.trim());
        },
      ),
      { numRuns: 100 },
    );
  });
});
