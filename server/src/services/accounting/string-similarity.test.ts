import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeName,
  levenshteinDistance,
  namesAreSimilar,
  getNameSimilarityThreshold,
  DEFAULT_NAME_SIMILARITY_THRESHOLD,
} from "./string-similarity.js";

describe("normalizeName", () => {
  it("lowercases input", () => {
    expect(normalizeName("Acme Inc")).toBe("acme inc");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeName("  Acme Inc  ")).toBe("acme inc");
  });

  it("collapses multiple internal spaces to single space", () => {
    expect(normalizeName("Acme   Inc")).toBe("acme inc");
  });

  it("strips common business-name punctuation", () => {
    expect(normalizeName("Acme, Inc.")).toBe("acme inc");
    expect(normalizeName("O'Reilly's Books")).toBe("oreillys books");
  });

  it("returns same value for equivalent inputs (idempotent)", () => {
    expect(normalizeName("acme inc")).toBe("acme inc");
    expect(normalizeName(normalizeName("Acme, Inc."))).toBe("acme inc");
  });

  it("treats 'Acme, Inc.' and 'Acme Inc' as equivalent", () => {
    expect(normalizeName("Acme, Inc.")).toBe(normalizeName("Acme Inc"));
  });
});

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("acme", "acme")).toBe(0);
  });

  it("returns length of other when one is empty", () => {
    expect(levenshteinDistance("", "acme")).toBe(4);
    expect(levenshteinDistance("acme", "")).toBe(4);
  });

  it("counts single-character substitution as 1", () => {
    expect(levenshteinDistance("acme", "acne")).toBe(1);
  });

  it("counts single-character insertion as 1", () => {
    expect(levenshteinDistance("acme", "acmen")).toBe(1);
  });

  it("counts single-character deletion as 1", () => {
    expect(levenshteinDistance("acme", "acm")).toBe(1);
  });

  it("counts 'Acme Corp' vs 'Acme Corporation' correctly", () => {
    // 'Acme Corp' (9) -> 'Acme Corporation' (16) = 7 insertions ('oration')
    expect(levenshteinDistance("acme corp", "acme corporation")).toBe(7);
  });

  it("is symmetric: d(a,b) === d(b,a)", () => {
    const a = "fooBar";
    const b = "Foobar Inc";
    expect(levenshteinDistance(a, b)).toBe(levenshteinDistance(b, a));
  });
});

describe("namesAreSimilar", () => {
  // Tests use explicit threshold to avoid env-var dependency
  it("returns true for identical names", () => {
    expect(namesAreSimilar("Acme Inc", "Acme Inc", 3)).toBe(true);
  });

  it("returns true after normalization for equivalent forms", () => {
    expect(namesAreSimilar("Acme, Inc.", "Acme Inc", 3)).toBe(true);
    expect(namesAreSimilar("ACME INC", "acme inc", 3)).toBe(true);
  });

  it("returns true for minor typos within threshold", () => {
    // 'Acme Inc' vs 'Acne Inc' = 1 edit
    expect(namesAreSimilar("Acme Inc", "Acne Inc", 3)).toBe(true);
  });

  it("returns false for significantly different names beyond threshold", () => {
    // 'Acme Corp' vs 'Acme Corporation' = 7 edits, threshold 3
    expect(namesAreSimilar("Acme Corp", "Acme Corporation", 3)).toBe(false);
  });

  it("returns false for completely different names", () => {
    expect(namesAreSimilar("Acme Inc", "Globex Co", 3)).toBe(false);
  });

  it("uses default threshold of 3 when not specified", () => {
    // 'abcd' vs 'wxyz' = 4 edits, default 3 threshold
    expect(namesAreSimilar("abcd", "wxyz")).toBe(false);
  });

  it("respects custom threshold parameter", () => {
    // 'Acme Corp' vs 'Acme Corporation' = 7 edits
    expect(namesAreSimilar("Acme Corp", "Acme Corporation", 10)).toBe(true);
    expect(namesAreSimilar("Acme Corp", "Acme Corporation", 6)).toBe(false);
  });
});

describe("getNameSimilarityThreshold", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD;
    } else {
      process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD = originalEnv;
    }
  });

  it("returns DEFAULT_NAME_SIMILARITY_THRESHOLD when env var not set", () => {
    delete process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD;
    expect(getNameSimilarityThreshold()).toBe(DEFAULT_NAME_SIMILARITY_THRESHOLD);
    expect(DEFAULT_NAME_SIMILARITY_THRESHOLD).toBe(3);
  });

  it("returns parsed integer from env var", () => {
    process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD = "5";
    expect(getNameSimilarityThreshold()).toBe(5);
  });

  it("falls back to default for non-numeric env var", () => {
    process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD = "abc";
    expect(getNameSimilarityThreshold()).toBe(DEFAULT_NAME_SIMILARITY_THRESHOLD);
  });

  it("falls back to default for negative env var", () => {
    process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD = "-1";
    expect(getNameSimilarityThreshold()).toBe(DEFAULT_NAME_SIMILARITY_THRESHOLD);
  });

  it("accepts 0 as a valid threshold (strict matching)", () => {
    process.env.LEDGERIX_NAME_SIMILARITY_THRESHOLD = "0";
    expect(getNameSimilarityThreshold()).toBe(0);
  });
});
