import type { DiscussionMessage, WorkNode, WorkUpdate } from "../types";
import { asanaLinks, asanaTaskGid } from "./asana-links";

export const ASANA_MANAGEMENT_TAG = "Управлінський_цикл";

export function primaryAsanaTitle(node: Pick<WorkNode, "code" | "title">) {
  return `${node.code.trim()} ${node.title.trim()}`.trim();
}

export function asanaTitleDiffers(node: Pick<WorkNode, "code" | "title">, remoteName: string) {
  return Boolean(remoteName.trim()) && primaryAsanaTitle(node).replace(/\s+/g, " ").trim() !== remoteName.replace(/\s+/g, " ").trim();
}

export function escapeAsanaHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const structureLevelLabels = { goal: "Стратегічна ціль", cycle: "Напрям зусиль", subcycle: "Проект", task: "Завдання" };

function structureTaskUrl(node: WorkNode) {
  const gid = node.asana.taskGid.trim();
  const linkedUrl = asanaLinks(node.asana.taskUrl).find((url) => {
    const linkedGid = asanaTaskGid(url);
    return linkedGid && (!gid || linkedGid === gid);
  });
  if (linkedUrl) return linkedUrl;
  if (/^\d{8,}$/.test(gid)) return `https://app.asana.com/0/0/${gid}`;
  // A single task pasted into the control place is usable even before OAuth linking.
  // Multiple task links are ambiguous: do not invent which one is the main task.
  const controlLinks = asanaLinks(node.controlPlace).filter((url) => asanaTaskGid(url));
  return controlLinks.length === 1 ? controlLinks[0] : "";
}

export function portalTaskDescriptionForAsana(nodes: WorkNode[], node: WorkNode, description?: string) {
  const byId = new Map(nodes.filter((item) => !item.deletedAt).map((item) => [item.id, item]));
  const path: WorkNode[] = [];
  const visited = new Set<string>();
  let current: WorkNode | undefined = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  const levels = path.map((item) => {
    const label = escapeAsanaHtml(`${structureLevelLabels[item.kind]}: ${item.code} · ${item.title}`);
    const url = structureTaskUrl(item);
    return url ? `<a href="${escapeAsanaHtml(url)}" data-asana-gid="${asanaTaskGid(url)}" data-asana-dynamic="false">${label}</a>` : label;
  });
  const structure = `<strong>МІСЦЕ В СТРУКТУРІ</strong>\n${levels.join(" →\n")}`;
  const plainDescription = description || `${node.code}\n\n${node.result}\n\nКритерій приймання: ${node.acceptanceCriteria}`;
  // Asana rich text keeps literal newlines; use only its documented XML tags.
  const htmlText = (value: string) => escapeAsanaHtml(value).replace(/\r\n/g, "\n");
  // Replace the existing generated plain-text path rather than adding a duplicate.
  const oldStructure = /(^|\n)МІСЦЕ В СТРУКТУРІ\n[\s\S]*?(?=\n\n|$)/.exec(plainDescription);
  const content = oldStructure
    ? `${htmlText(plainDescription.slice(0, oldStructure.index))}${oldStructure[1]}${structure}${htmlText(plainDescription.slice(oldStructure.index + oldStructure[0].length))}`
    : `${structure}\n\n${htmlText(plainDescription)}`;
  return `<body>${content}</body>`;
}

export function portalMessageForAsana(message: DiscussionMessage, authorName: string, actionUrl: string, recipientGid?: string) {
  const category = message.kind === "question" ? "Питання" : message.kind === "issue" ? "Перешкода" : message.kind === "decision" ? "Рішення" : message.kind === "approval" ? "Погодження" : "Коментар";
  const mention = recipientGid ? `<a data-asana-gid="${escapeAsanaHtml(recipientGid)}"/> ` : "";
  return `<body>${mention}<strong>${category} · ${escapeAsanaHtml(authorName)}</strong><br/>${escapeAsanaHtml(message.text).replace(/\n/g, "<br/>")}<br/><a href="${escapeAsanaHtml(actionUrl)}">Відкрити дію в порталі</a><br/><em>УП:${escapeAsanaHtml(message.id)}</em></body>`;
}

export function portalReportForAsana(report: WorkUpdate, authorName: string, actionUrl: string) {
  return `<body><strong>Звіт · ${escapeAsanaHtml(authorName)}</strong><br/>${escapeAsanaHtml(report.summary).replace(/\n/g, "<br/>")}${report.nextAction ? `<br/>Наступна дія: ${escapeAsanaHtml(report.nextAction).replace(/\n/g, "<br/>")}` : ""}<br/><a href="${escapeAsanaHtml(actionUrl)}">Відкрити звіт у порталі</a><br/><em>УП:${escapeAsanaHtml(report.id)}</em></body>`;
}

export function portalOriginId(text: string) {
  return text.match(/УП:([0-9a-f-]{36})/i)?.[1] || "";
}
