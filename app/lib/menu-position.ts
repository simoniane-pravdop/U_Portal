type Rect = { left: number; right: number; top: number; bottom: number };

export function menuPosition(anchor: Rect, menu: { width: number; height: number }, viewport: { width: number; height: number }) {
  const gap = 6;
  const edge = 8;
  const left = Math.max(edge, Math.min(anchor.right - menu.width, viewport.width - menu.width - edge));
  const below = anchor.bottom + gap;
  const preferred = below + menu.height <= viewport.height - edge ? below : anchor.top - menu.height - gap;
  const top = Math.max(edge, Math.min(preferred, viewport.height - menu.height - edge));
  return { left, top };
}
