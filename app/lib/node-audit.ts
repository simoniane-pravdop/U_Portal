import type { AuditEntry, PortalUser, WorkNode } from "../types";

const labels: Record<string, string> = {
  parentId: "Батьківський рівень", linkedParentIds: "Додатково відображати у", code: "Код", kind: "Рівень", title: "Назва",
  description: "Опис", result: "Готовий результат", nonResult: "Що не є результатом",
  acceptanceCriteria: "Критерій приймання", assigneeId: "Виконавець", acceptorId: "Ініціатор",
  participantIds: "Учасники", lifecycle: "Статус", lifecycleOverride: "Статус (ручне правило)",
  health: "Стан", healthOverride: "Стан (ручне правило)", healthComment: "Коментар до стану",
  decisionRequired: "Потрібне рішення", priority: "Пріоритет", plannedStart: "Плановий початок",
  plannedEnd: "Строк завершення", forecastEnd: "Прогноз завершення", actualStart: "Фактичний початок",
  actualEnd: "Фактичне завершення", progress: "Прогрес", weight: "Вага", startMode: "Спосіб початку",
  resource: "Ресурс", authority: "Обмеження повноважень", coordinationCadence: "Періодичність координації",
  coordinationStartDate: "Перша координація", coordinationIntervalDays: "Інтервал координації",
  coordinationWeekday: "День координації", controlPlace: "Контрольне місце", visibility: "Доступ",
  archived: "Архів", deletedAt: "Дата видалення", deletedById: "Видалив", evidence: "Докази", recurrence: "Повторення", asana: "Asana", updates: "Робочі звіти",
};

const statuses: Record<string, string> = { draft: "Чернетка", idea: "Ідея", planned: "Заплановано", ready: "Готово до старту", in_progress: "У роботі", acceptance: "На прийманні", completed: "Завершено", paused: "Призупинено", cancelled: "Скасовано", normal: "Нормально", risk: "Є ризик", blocked: "Заблоковано" };

type AuditChanges = NonNullable<AuditEntry["changes"]>;
type AsanaSnapshot = Partial<WorkNode["asana"]>;

function taskAuditValue(value: AsanaSnapshot) {
  let href = "";
  try {
    const url = new URL(value.taskUrl || "");
    if (url.protocol === "https:" && url.hostname === "app.asana.com") href = url.href;
  } catch { /* A missing link can still be reconstructed from the task identifier. */ }
  if (!href && /^\d{8,}$/.test(value.taskGid || "")) href = `https://app.asana.com/0/0/${value.taskGid}`;
  return { text: value.remoteName || (value.taskGid ? `Задача Asana #${value.taskGid}` : href ? "Задача Asana" : "Не прив’язано"), href };
}

function asanaAuditChanges(before: AsanaSnapshot = {}, after: AsanaSnapshot = {}): AuditChanges {
  const changes: AuditChanges = [];
  const from = taskAuditValue(before);
  const to = taskAuditValue(after);
  if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field: "asana.task", label: "Основна задача Asana", from: from.text, to: to.text, fromHref: from.href, toHref: to.href });
  const fields = { remoteCompleted: "Asana · завершення", remoteDueOn: "Asana · строк", remoteAssignee: "Asana · виконавець", remoteFollowerCount: "Asana · кількість учасників", remoteParentGid: "Asana · батьківська задача", projectGid: "Asana · проєкт", workspaceGid: "Asana · робочий простір", sectionGid: "Asana · розділ", syncState: "Asana · стан зв’язку" };
  const syncLabels: Record<string, string> = { not_linked: "Не прив’язано", linked: "Прив’язано", pending: "Очікує синхронізації", conflict: "Конфлікт", error: "Помилка" };
  for (const [key, label] of Object.entries(fields)) {
    const oldValue = before[key as keyof AsanaSnapshot];
    const newValue = after[key as keyof AsanaSnapshot];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    const readable = (value: unknown) => key === "syncState" ? syncLabels[String(value)] || "Не вказано" : format(value, key, [], []);
    changes.push({ field: `asana.${key}`, label, from: readable(oldValue), to: readable(newValue) });
  }
  const ruleLabels = { title: "Назва", assignee: "Виконавець", dates: "Дати", status: "Статус", description: "Опис" };
  const sources: Record<string, string> = { portal: "Портал", asana: "Asana", manual: "Ручне узгодження" };
  for (const [key, label] of Object.entries(ruleLabels)) {
    const oldValue = before.rules?.[key as keyof typeof ruleLabels];
    const newValue = after.rules?.[key as keyof typeof ruleLabels];
    if (oldValue !== newValue) changes.push({ field: `asana.rules.${key}`, label: `Джерело даних · ${label}`, from: sources[oldValue || ""] || "Не вказано", to: sources[newValue || ""] || "Не вказано" });
  }
  return changes;
}

/** Present old JSON diffs without rewriting the immutable server journal. */
export function auditChangesForDisplay(changes: AuditChanges = []): AuditChanges {
  return changes.flatMap((change) => {
    if (change.field !== "asana") return [change];
    const parse = (value: string): AsanaSnapshot => {
      const parsed = value.startsWith("{") ? JSON.parse(value) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Asana snapshot");
      return parsed;
    };
    try { return asanaAuditChanges(parse(change.from), parse(change.to)); }
    catch { return [{ field: "asana", label: "Asana", from: "Попередні налаштування інтеграції", to: "Налаштування інтеграції оновлено" }]; }
  });
}

function format(value: unknown, key: string, users: PortalUser[], nodes: WorkNode[]): string {
  if (value === undefined || value === null || value === "") return "Не вказано";
  if (typeof value === "boolean") return value ? "Так" : "Ні";
  if (Array.isArray(value)) return value.length ? value.map((item) => format(item, key === "participantIds" ? "assigneeId" : key === "linkedParentIds" ? "parentId" : key, users, nodes)).join("; ") : "Немає";
  if (typeof value === "object") return JSON.stringify(value);
  if (["assigneeId", "acceptorId", "deletedById"].includes(key)) return users.find((user) => user.id === value)?.name || String(value);
  if (key === "parentId") { const node = nodes.find((item) => item.id === value); return node ? `${node.code} · ${node.title}` : String(value); }
  if (["lifecycle", "lifecycleOverride", "health", "healthOverride"].includes(key)) return statuses[String(value)] || String(value);
  return String(value);
}

/** A server-side, immutable diff; timestamps and creator are recorded separately. */
export function nodeAuditChanges(before: WorkNode | undefined, after: WorkNode, users: PortalUser[] = [], nodes: WorkNode[] = []): NonNullable<AuditEntry["changes"]> {
  const ignored = new Set(["id", "createdAt", "createdById", "updatedAt", "ownerId", "deletedBatchId", "trashPreviousArchived"]);
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after)]);
  return [...keys].filter((key) => !ignored.has(key)).flatMap((key) => {
    const oldValue = before?.[key as keyof WorkNode];
    const newValue = after[key as keyof WorkNode];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
    if (key === "asana") return asanaAuditChanges(before?.asana, after.asana);
    if (key === "updates") {
      const oldCount = (before?.updates || []).length;
      const newCount = (after.updates || []).length;
      return [{ field: key, label: labels[key], from: `${oldCount} звітів`, to: `${newCount} звітів` }];
    }
    return [{ field: key, label: labels[key] || key, from: format(oldValue, key, users, nodes), to: format(newValue, key, users, nodes) }];
  });
}
