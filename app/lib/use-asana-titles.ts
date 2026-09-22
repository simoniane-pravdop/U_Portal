"use client";

import { useEffect, useMemo, useState } from "react";
import { asanaLinks, asanaTaskGid } from "./asana-links";
import type { WorkNode } from "../types";

export type AsanaTitles = Record<string, string>;

const pending = new Map<string, Promise<AsanaTitles>>();

function readTitles(nodeId: string): Promise<AsanaTitles> {
  const existing = pending.get(nodeId);
  if (existing) return existing;
  const request = fetch(`/api/asana/titles?nodeId=${encodeURIComponent(nodeId)}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return {};
      const result = await response.json() as { titles?: AsanaTitles };
      return result.titles || {};
    })
    .catch(() => ({}))
    .finally(() => pending.delete(nodeId));
  pending.set(nodeId, request);
  return request;
}

export function useAsanaTitles(node: WorkNode): AsanaTitles {
  const links = useMemo(() => asanaLinks(node.controlPlace, node.description, node.asana.taskUrl, ...node.evidence.map((item) => item.value)), [node.controlPlace, node.description, node.asana.taskUrl, node.evidence]);
  const linkedTitles = useMemo(() => Object.fromEntries(links.filter((url) => asanaTaskGid(url) === node.asana.taskGid && node.asana.remoteName).map((url) => [url, node.asana.remoteName!])), [links, node.asana.taskGid, node.asana.remoteName]);
  const [resolved, setResolved] = useState<AsanaTitles>({});

  useEffect(() => {
    if (!links.length) return;
    let active = true;
    void readTitles(node.id).then((titles) => { if (active) setResolved(titles); });
    return () => { active = false; };
  }, [node.id, links]);

  return { ...resolved, ...linkedTitles };
}
