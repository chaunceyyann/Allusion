import { PredictedTag, TagMapping } from './autoTagTypes';

/**
 * Parses the raw content of a caption file (comma-separated tag names).
 * Splits by comma, trims whitespace from each entry, and filters out empty strings.
 *
 * Extracted as a pure function for testability without file-system access.
 */
export function parseCaptionContent(content: string): string[] {
  return content
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Parses the content of a `selected_tags.csv` string into an ordered array of
 * TagMapping entries. Category codes: 0 = general, 4 = character, 9 = rating.
 *
 * Accepts the raw CSV string (not a file path) so it can be tested without
 * file-system access.
 */
export function parseTagCsvContent(content: string): TagMapping[] {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  const mappings: TagMapping[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip header row if present. We check whether the first field is non-numeric
    // (e.g. "tag_id") to distinguish a header from a data row whose tag name
    // happens to contain "name".
    if (i === 0) {
      const firstField = line.split(',')[0].trim();
      if (isNaN(Number(firstField))) {
        continue;
      }
    }

    const parts = line.split(',');
    if (parts.length < 3) continue;

    const index = parseInt(parts[0], 10);
    const name = parts[1].trim();
    const categoryCode = parseInt(parts[2], 10);

    let category: 'general' | 'character' | 'rating';
    switch (categoryCode) {
      case 0:
        category = 'general';
        break;
      case 4:
        category = 'character';
        break;
      case 9:
        category = 'rating';
        break;
      default:
        category = 'general';
        break;
    }

    mappings.push({ index, name, category });
  }

  return mappings;
}

/**
 * Applies the sigmoid activation function to convert a logit into a probability.
 * Returns a value in the open interval (0, 1).
 */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Filters predicted tags by category-specific thresholds, excludes all rating
 * tags, and returns the remaining tags sorted by score in descending order.
 *
 * - General tags are retained only if `score >= generalThreshold`
 * - Character tags are retained only if `score >= characterThreshold`
 * - Rating tags are always excluded
 */
export function filterAndSortTags(
  tags: PredictedTag[],
  generalThreshold: number,
  characterThreshold: number,
): PredictedTag[] {
  return tags
    .filter((tag) => {
      if (tag.category === 'rating') {
        return false;
      }
      if (tag.category === 'general') {
        return tag.score >= generalThreshold;
      }
      if (tag.category === 'character') {
        return tag.score >= characterThreshold;
      }
      return false;
    })
    .sort((a, b) => b.score - a.score);
}
