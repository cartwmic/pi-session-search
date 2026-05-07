import type { ParsedSession } from "../parser"

/**
 * Build a concatenated raw-content string for FTS5 indexing.
 *
 * Includes: headline, userMessages (≤6 KB bytes), compactionSummaries
 * (≤4 KB bytes), branchSummaries (≤2 KB bytes), normalized filesModified.
 * Excludes assistantText entirely.
 *
 * Final result is byte-truncated to 12 KB, preserving UTF-8 character
 * boundaries.
 */
export function buildRawFtsContent(session: ParsedSession): string {
  // Headline: name or first user message (full, no cap)
  const headline = session.name ?? session.firstUserMessage

  // User messages joined \n, byte-capped at 6 KB
  const userBlock = safeUtf8Truncate(session.userMessages.join("\n"), 6 * 1024)

  // Compaction summaries joined \n, byte-capped at 4 KB
  const compactionBlock = safeUtf8Truncate(
    session.compactionSummaries.join("\n"),
    4 * 1024,
  )

  // Branch summaries joined \n, byte-capped at 2 KB
  const branchBlock = safeUtf8Truncate(
    session.branchSummaries.join("\n"),
    2 * 1024,
  )

  // Normalize filesModified paths for FTS5 word-boundary tokenization
  const filesNormalized = normalizeFilesModified(session.filesModified)

  // Concatenation order per spec: headline, userMessages, compactionSummaries,
  // branchSummaries, normalized filesModified
  const parts = [headline, userBlock, compactionBlock, branchBlock, filesNormalized]
  const joined = parts.filter(Boolean).join("\n")

  // Final byte-cap at 12 KB total
  return safeUtf8Truncate(joined, 12 * 1024)
}

/**
 * Normalize filesModified paths for FTS5 tokenization.
 *  - Replace `/` with ` / ` so path components become separate tokens
 *  - Strip lines matching long base64 (200+ alphanumeric+/= chars)
 *  - Collapse multi-whitespace runs to single space
 */
function normalizeFilesModified(files: string[]): string {
  const cleaned: string[] = []
  for (const f of files) {
    // Strip long base64-like lines
    if (/^[A-Za-z0-9+/=]{200,}$/.test(f)) continue
    // Replace / with space-slash-space for word boundary tokenization
    const normalized = f.replace(/\//g, " / ")
    cleaned.push(normalized)
  }
  return cleaned.join(" ").replace(/\s+/g, " ").trim()
}

/**
 * Truncate a string to at most `maxBytes` bytes, preserving UTF-8 character
 * boundaries (no replacement characters or broken surrogates).
 */
export function safeUtf8Truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text

  // Binary-search for the safe cut point
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    const slice = text.slice(0, mid)
    if (Buffer.byteLength(slice, "utf8") <= maxBytes) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  // Guard: if the cut lands between a high-surrogate (D800-DBFF) and its
  // low-surrogate partner, drop the lone high-surrogate so the result is
  // valid UTF-16 and round-trips through UTF-8 without replacement chars.
  if (lo > 0) {
    const lastCode = text.charCodeAt(lo - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      lo -= 1
    }
  }
  return text.slice(0, lo)
}
