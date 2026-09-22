import type { AuditEntry, PortalUser, WorkNode } from "../types";

const labels: Record<string, string> = {
  parentId: "Батьківський рівень", code: "Код", kind: "Рівень", title: "Назва",
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
  archived: "Архів", evidence: "Докази", recurrence: "Повторення", asana: "Asana", updates: "Робочі звіти",
};

const statuses: Record<string, string> = { draft: "Чернетка", idea: "Ідея", planned: "Заплановано", ready: "Готово до старту", in_progress: "У роботі", acceptance: "На прийманні", completed: "Завершено", paused: "Призупинено", cancelled: "Скасовано", normal: "Нормально", risk: "Є ризик", blocked: "Заблоковано" };

function format(value: unknown, key: string, users: PortalUser[], nodes: WorkNode[]): string {
  if (value === undefined || value === null || value === "") return "Не вказано";
  if (typeof value === "boolean") return value ? "Так" : "Ні";
  if (Array.isArray(value)) return value.length ? value.map((item) => format(item, key === "participantIds" ? "assigneeId" : key, users, nodes)).join("; ") : "Немає";
  if (typeof value === "object") return JSON.stringify(value);
  if (["assigneeId", "acceptorId"].includes(key)) return users.find((user) => user.id === value)?.name || String(value);
  if (key === "parentId") { const node = nodes.find((item) => item.id === value); return node ? `${node.code} · ${node.title}` : String(value); }
  if (["lifecycle", "lifecycleOverride", "health", "healthOverride"].includes(key)) return statuses[String(value)] || String(value);
  return String(value);
}

/** A server-side, immutable diff; timestamps and creator are recorded separately. */
export function nodeAuditChanges(before: WorkNode | undefined, after: WorkNode, users: PortalUser[] = [], nodes: WorkNode[] = []): NonNullable<AuditEntry["changes"]> {
  const ignored = new Set(["id", "createdAt", "createdById", "updatedAt", "ownerId"]);
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after)]);
  return [...keys].filter((key) => !ignored.has(key)).flatMap((key) => {
    const oldValue = before?.[key as keyof WorkNode];
    const newValue = after[key as keyof WorkNode];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
    if (key === "updates") {
      const oldCount = (before?.updates || []).length;
      const newCount = (after.updates || []).length;
      return [{ field: key, label: labels[key], from: `${oldCount} звітів`, to: `${newCount} звітів` }];
    }
    return [{ field: key, label: labels[key] || key, from: format(oldValue, key, users, nodes), to: format(newValue, key, users, nodes) }];
  });
}
