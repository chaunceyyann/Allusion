/**
 * Pure tag mapping utilities extracted from AutoTagger for testability.
 *
 * These functions implement the core tag normalization and matching logic
 * used when mapping predicted tags from the WD Tagger model into Allusion's
 * tag system.
 */

/**
 * Normalizes a predicted tag name by replacing all underscores with spaces.
 * WD Tagger models use underscores in tag names (e.g., "long_hair"),
 * but Allusion's tag system uses spaces (e.g., "long hair").
 */
export function normalizeTagName(name: string): string {
  return name.replace(/_/g, ' ');
}

/**
 * Finds an existing tag in the tag list by case-insensitive comparison
 * against the normalized name.
 *
 * @returns The matching tag object, or undefined if no match exists.
 */
export function findExistingTag<T extends { name: string }>(
  normalizedName: string,
  tagList: readonly T[],
): T | undefined {
  return tagList.find((t) => t.name.toLowerCase() === normalizedName.toLowerCase());
}

/**
 * Result of mapping a single predicted tag name against a tag store.
 */
export interface TagMappingResult {
  /** The normalized name (underscores replaced with spaces) */
  normalizedName: string;
  /** Whether an existing tag was found (true) or a new one would be created (false) */
  isExisting: boolean;
}

/**
 * Maps an array of predicted tag names against an existing tag list.
 * For each predicted name:
 * 1. Normalizes the name (replaces underscores with spaces)
 * 2. Searches for a case-insensitive match in the existing tag list
 * 3. Records whether the tag is existing or new
 *
 * Returns the mapping results and the final set of tag names that would
 * exist after all mappings are applied (existing + newly created).
 */
export function mapPredictedTags(
  predictedNames: string[],
  existingTagNames: string[],
): { results: TagMappingResult[]; finalTagNames: string[] } {
  // Track all tag names that exist (case-insensitive, using lowercase keys)
  const tagNameSet = new Map<string, string>();
  for (const name of existingTagNames) {
    tagNameSet.set(name.toLowerCase(), name);
  }

  const results: TagMappingResult[] = [];

  for (const predicted of predictedNames) {
    const normalizedName = normalizeTagName(predicted);
    const lowerName = normalizedName.toLowerCase();
    const isExisting = tagNameSet.has(lowerName);

    if (!isExisting) {
      // A new tag would be created — add it to the set so subsequent
      // duplicates in the same batch are detected as existing.
      tagNameSet.set(lowerName, normalizedName);
    }

    results.push({ normalizedName, isExisting });
  }

  return {
    results,
    finalTagNames: Array.from(tagNameSet.values()),
  };
}
