import { createTwoFilesPatch, diffLines } from 'diff';

export function lineStats(before: string, after: string): { added: number; removed: number; unchanged: boolean } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const n = part.count ?? part.value.split('\n').length - 1;
    if (part.added) added += n;
    else if (part.removed) removed += n;
  }
  return { added, removed, unchanged: added === 0 && removed === 0 };
}

/** Unified diff, truncated to maxLines so a large page never floods the context. */
export function unifiedDiff(before: string, after: string, names: { before: string; after: string }, context = 3, maxLines = 400): string {
  const patch = createTwoFilesPatch(names.before, names.after, before, after, '', '', { context });
  const lines = patch.split('\n');
  if (lines.length <= maxLines) return patch;
  return [...lines.slice(0, maxLines), `… diff truncated (${lines.length - maxLines} more lines). Narrow the change or compare locally.`].join('\n');
}
