// String similarity utilities for Phase 4c safety architecture per ADR-003 Q7.
//
// Used by findOrCreateCustomer to detect ambiguous name matches (where
// a customer record matches by name but has a different email than the
// one being submitted). The threshold is configurable; default of 3
// matches ADR-003 Q7's starting recommendation.

// Normalize a string for comparison:
//   - lowercase
//   - trim leading/trailing whitespace
//   - collapse multiple internal spaces to single
//   - strip common punctuation that varies in business names
//     ('Acme, Inc.' and 'Acme Inc' should normalize to the same value)
//
// Returns the normalized string. Original is not modified.
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    // Remove common business-name punctuation: commas, periods, apostrophes
    .replace(/[.,']/g, "")
    // Collapse multiple whitespace characters to single space
    .replace(/\s+/g, " ");
}

// Compute Levenshtein distance between two strings.
//
// Levenshtein distance = the minimum number of single-character edits
// (insertions, deletions, substitutions) required to change one string
// into the other.
//
// Examples:
//   levenshtein("Acme Inc", "Acme Inc") = 0
//   levenshtein("Acme Inc", "Acne Inc") = 1 (one substitution)
//   levenshtein("Acme Corp", "Acme Corporation") = 7 (six insertions + spelling)
//
// Standard dynamic-programming implementation. O(m*n) time, O(min(m,n))
// space (we use the full matrix here for clarity; could be optimized
// if performance becomes a concern).
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // dp[i][j] = distance between a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,             // deletion
        dp[i][j - 1] + 1,             // insertion
        dp[i - 1][j - 1] + substitutionCost, // substitution (or match)
      );
    }
  }

  return dp[a.length][b.length];
}

// Default ambiguity threshold per ADR-003 Q7. Two normalized names with
// Levenshtein distance > this value are considered "different" (trigger
// approval); distance <= this value is treated as a match.
//
// Configurable via env var LEDGERIX_NAME_SIMILARITY_THRESHOLD; defaults
// to 3 if not set or invalid.
export const DEFAULT_NAME_SIMILARITY_THRESHOLD = 3;

export function getNameSimilarityThreshold(): number {
  const raw = process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD;
  if (!raw) return DEFAULT_NAME_SIMILARITY_THRESHOLD;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) return DEFAULT_NAME_SIMILARITY_THRESHOLD;
  return parsed;
}

// Check whether two names are similar enough to be considered the same.
// Returns true if names match after normalization OR Levenshtein distance
// of the normalized forms is <= threshold.
//
// Used by findOrCreateCustomer to determine whether a name-match-without-
// email-match is silent-acceptable or HITL-flagged.
export function namesAreSimilar(
  name1: string,
  name2: string,
  threshold: number = getNameSimilarityThreshold(),
): boolean {
  const normalized1 = normalizeName(name1);
  const normalized2 = normalizeName(name2);
  if (normalized1 === normalized2) return true;
  return levenshteinDistance(normalized1, normalized2) <= threshold;
}
