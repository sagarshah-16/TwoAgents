import { describe, expect, it } from "vitest";
import { changedFilesFromDiff, extractUnifiedDiff } from "../shared/diff";

describe("diff helpers", () => {
  it("extracts fenced diffs and changed files", () => {
    const diff = extractUnifiedDiff("text\n```diff\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n```\n");

    expect(diff).toContain("diff --git");
    expect(changedFilesFromDiff(diff)).toEqual(["a.txt"]);
  });
});
