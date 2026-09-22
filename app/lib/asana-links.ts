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

export function asanaTaskGid(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["app.asana.com", "asana.com", "www.asana.com"].includes(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const taskIndex = parts.indexOf("task");
    if (taskIndex >= 0) return /^\d{8,}$/.test(parts[taskIndex + 1] || "") ? parts[taskIndex + 1] : null;
    if (parts[0] === "0") {
      const candidate = parts[2];
      return /^\d{8,}$/.test(candidate || "") ? candidate : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function asanaLinkLabel(url: string, title?: string): string {
  if (title?.trim()) return title.trim();
  const gid = asanaTaskGid(url);
  return gid ? `Задача Asana #${gid} · назву ще не отримано` : url;
}
