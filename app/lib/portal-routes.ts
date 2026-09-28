export const portalPaths = {
  dashboard: "/dashbord",
  inbox: "/vkhidni",
  calendar: "/kalendar",
  tree: "/derevo-tsilei",
  my: "/moia-robota",
  coordination: "/koordynatsiia",
  ideas: "/idei",
  settings: "/nalashtuvannia",
} as const;

export type PortalView = keyof typeof portalPaths;
export type PortalFocus = "blocker" | "decision" | "acceptance" | "discussion" | "reports" | null;

export function portalViewForPath(pathname: string): PortalView | undefined {
  const path = pathname.replace(/\/$/, "");
  return (Object.keys(portalPaths) as PortalView[]).find((view) => portalPaths[view] === path);
}

export function readPortalRoute(url: URL) {
  const legacyView = url.searchParams.get("view");
  const view = portalViewForPath(url.pathname)
    || (url.pathname === "/" && legacyView && Object.hasOwn(portalPaths, legacyView) ? legacyView as PortalView : "dashboard");
  const nodeId = ["my", "tree"].includes(view) ? url.searchParams.get("node") || "" : "";
  const requestedFocus = url.searchParams.get("focus");
  const focus = view === "my" && ["blocker", "decision", "acceptance", "discussion", "reports"].includes(requestedFocus || "")
    ? requestedFocus as PortalFocus : null;
  return { view, nodeId, focus };
}

/** Keep unrelated callback parameters and hashes, but never leak a card into another section. */
export function canonicalPortalUrl(current: URL, view: PortalView, nodeId?: string, focus: PortalFocus = null) {
  const url = new URL(current);
  url.pathname = portalPaths[view];
  url.searchParams.delete("view");
  if (nodeId && ["my", "tree"].includes(view)) url.searchParams.set("node", nodeId);
  else url.searchParams.delete("node");
  if (view === "my" && nodeId && focus) url.searchParams.set("focus", focus);
  else url.searchParams.delete("focus");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function portalHref(view: PortalView, nodeId?: string, focus: PortalFocus = null) {
  return canonicalPortalUrl(new URL("https://portal.invalid"), view, nodeId, focus);
}
