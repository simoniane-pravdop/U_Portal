const urlPattern = /https?:\/\/[^\s<>"']+/gi;
const trailingPunctuation = /[.,;:!?)}\]]+$/;

export function asanaLinks(...values: string[]): string[] {
  const links = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(urlPattern)) {
      const raw = match[0].replace(trailingPunctuation, "");
      try {
        const url = new URL(raw);
        if (url.protocol === "https:" && (url.hostname === "app.asana.com" || url.hostname === "asana.com" || url.hostname === "www.asana.com")) {
          links.add(url.href);
        }
      } catch { /* Invalid pasted links stay in the card text, but are not opened. */ }
    }
  }
  return [...links];
}
