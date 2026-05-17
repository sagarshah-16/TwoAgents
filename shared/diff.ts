export function extractUnifiedDiff(text: string): string | undefined {
  const fenced = text.match(/```(?:diff|patch)\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.includes("diff --git")) {
    return fenced[1].trim();
  }

  const start = text.indexOf("diff --git ");
  if (start === -1) {
    return undefined;
  }

  return text.slice(start).trim();
}

export function changedFilesFromDiff(diff?: string): string[] {
  if (!diff) {
    return [];
  }

  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      files.add(match[2]);
    }
  }
  return [...files].sort();
}
