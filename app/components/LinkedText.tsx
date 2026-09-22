import { Fragment } from "react";
import { asanaLinkLabel, asanaTaskGid } from "../lib/asana-links";
import type { AsanaTitles } from "../lib/use-asana-titles";

const urlPattern = /https?:\/\/[^\s<>"']+/gi;
const trailingPunctuation = /[.,;:!?)}\]]+$/;

export function LinkedText({ value, asanaTitles = {} }: { value: string; asanaTitles?: AsanaTitles }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    const start = match.index;
    if (start > cursor) parts.push(value.slice(cursor, start));
    const raw = match[0];
    const suffix = raw.match(trailingPunctuation)?.[0] || "";
    const href = raw.slice(0, raw.length - suffix.length);
    let safeUrl: string | null = null;
    try {
      const url = new URL(href);
      if (url.protocol === "https:" || url.protocol === "http:") safeUrl = url.href;
    } catch { /* A malformed URL remains plain text. */ }
    parts.push(safeUrl ? <a key={start} href={safeUrl} target="_blank" rel="noopener noreferrer">{asanaTaskGid(safeUrl) ? asanaLinkLabel(safeUrl, asanaTitles[safeUrl]) : href}</a> : href);
    if (suffix) parts.push(suffix);
    cursor = start + raw.length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return <Fragment>{parts}</Fragment>;
}
