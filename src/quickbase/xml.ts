/**
 * Helpers for the legacy XML API.
 *
 * Responses are scanned with targeted matches rather than a full XML parser:
 * API_GetDBPage returns arbitrary HTML that a strict parser would reject.
 * The CDATA escaping mirrors qb-deploy's adapter, including the `]]>` split,
 * which otherwise silently truncates a page.
 */

/** CDATA ends at the first `]]>`; split the marker so the page body survives intact. */
export function escapeCdata(body: string): string {
  return String(body).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/** Reverse escapeCdata() on read, so round trips are lossless. */
export function unsplitCdata(s: string): string {
  return s.split(']]]]><![CDATA[>').join(']]>');
}

export function escapeXmlText(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Text of the first <tag>...</tag> (case-insensitive), or null. */
export function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

/** Inner text of every <tag>...</tag>. */
export function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

export function extractAttr(xml: string, tag: string, attr: string): string | null {
  const m = xml.match(new RegExp(`<${tag}\\s[^>]*\\b${attr}="([^"]*)"`, 'i'));
  return m ? decodeXmlEntities(m[1]) : null;
}

/** Unwrap one CDATA section (reversing the split marker), or null if the text is not CDATA. */
export function stripCdata(s: string): string | null {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return m ? unsplitCdata(m[1]) : null;
}

/** Text content that may be CDATA or entity-encoded. */
export function textContent(s: string | null): string | null {
  if (s === null) return null;
  return stripCdata(s) ?? decodeXmlEntities(s);
}
