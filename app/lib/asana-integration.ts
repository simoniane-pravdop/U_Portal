import type { DiscussionMessage, WorkNode, WorkUpdate } from "../types";

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
