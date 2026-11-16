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

/**
 * API_GetDBPage returns code pages with "<BR/>" added at the end of every
 * line; the stored page has none. These helpers recognise that pattern.
 */
const LINE_MARKER = '<BR/>';

/** Lines that end with the marker, and lines that have any text (the last line, with no line break after it, is not counted). */
export function lineMarkerStats(body: string): { marked: number; lines: number } {
  const lines = body.split('\n');
  lines.pop();
  let marked = 0;
  let withText = 0;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.endsWith(LINE_MARKER)) marked++;
    if (line.trim()) withText++;
  }
  return { marked, lines: withText };
}

/**
 * Remove the API's line markers, only when every line with text carries one
 * (blank lines may or may not). One "<BR/>" is removed per line, so a line
 * that already ended with <BR/> before the API added its own keeps it.
 */
export function stripLineMarkers(body: string): string {
  const { marked, lines } = lineMarkerStats(body);
  if (marked === 0 || marked < lines) return body;
  return body.replace(/<BR\/>(?=\r?\n)/g, '').replace(/<BR\/>$/, '');
}

/** Text content that may be CDATA or entity-encoded. */
export function textContent(s: string | null): string | null {
  if (s === null) return null;
  return stripCdata(s) ?? decodeXmlEntities(s);
}
