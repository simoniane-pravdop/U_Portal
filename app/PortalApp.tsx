"use client";
/* eslint-disable @next/next/no-img-element -- the bundled 145×48 brand asset is already optimized and vinext-compatible */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  Acceptance,
  Blocker,
  CoordinationSnapshot,
  Decision,
  Dependency,
  DiscussionMessage,
  EditingLock,
  Evidence,
  HealthStatus,
  LifecycleStatus,
  NodeKind,
  PortalPayload,
  PortalNotification,
  PortalState,
  PortalUser,
  StartMode,
  WorkUpdate,
  WorkNode,
} from "./types";

type View = "dashboard" | "inbox" | "calendar" | "tree" | "my" | "coordination" | "settings";
type Modal = "node" | "blocker" | "decision" | "coordination" | "dependency" | "evidence" | null;
type WorkFilter = "action" | "manage" | "acceptance" | "all";
type WorkFocus = "blocker" | "decision" | "acceptance" | "discussion" | null;
type NoticeTone = "success" | "error";
type Notify = (value: string, tone?: NoticeTone) => void;
type NodeErrors = Partial<Record<keyof WorkNode, string>>;
type TelegramStatus = {
  configured: boolean;
  connected: boolean;
  connection?: { telegram_username?: string; linked_at?: string; updated_at?: string } | null;
  bot?: { username: string; name: string };
  webhook?: { active: boolean; url: string; pending: number; error: string };
  error?: string;
};

const lifecycleLabels: Record<LifecycleStatus, string> = {
  draft: "Чернетка",
  planned: "Заплановано",
  ready: "Готово до старту",
  in_progress: "У роботі",
  acceptance: "На прийманні",
  completed: "Завершено",
  paused: "Призупинено",
  cancelled: "Скасовано",
};
const healthLabels: Record<HealthStatus, string> = { normal: "Нормально", risk: "Є ризик", blocked: "Заблоковано" };
const kindLabels: Record<NodeKind, string> = { goal: "Стратегічна ціль", cycle: "Управлінський цикл", subcycle: "Підцикл", task: "Завдання" };
const priorityLabels: Record<WorkNode["priority"], string> = { critical: "Критичний", high: "Високий", normal: "Нормальний", low: "Низький" };
const startLabels: Record<StartMode, string> = {
  with_parent: "Разом із батьківським рівнем",
  manual_capacity: "Після звільнення ресурсу",
  fixed_date: "У визначену дату",
  after_dependency: "Після залежності",
};
const roleLabels: Record<string, string> = {
  owner: "Власник порталу",
  admin: "Адміністратор",
  goal_owner: "Координатор цілі",
  cycle_owner: "Координатор циклу",
  coordinator: "Координатор",
  executor: "Виконавець",
  viewer: "Спостерігач",
};
const nav: Array<{ id: View; label: string; hint: string; icon: string }> = [
  { id: "dashboard", label: "Дашборд", hint: "Результати й відхилення", icon: "▦" },
  { id: "inbox", label: "Вхідні", hint: "Сповіщення та звернення", icon: "●" },
  { id: "calendar", label: "Календар", hint: "Строки й координації", icon: "▤" },
  { id: "tree", label: "Дерево цілей", hint: "Цикли та завдання", icon: "⌘" },
  { id: "my", label: "Моя робота", hint: "Виконання й звіти", icon: "☑" },
  { id: "coordination", label: "Координація", hint: "Зведення за циклами", icon: "↔" },
  { id: "settings", label: "Налаштування", hint: "Бібліотеки й інтеграції", icon: "⚙" },
];

function isoNow() {
  return new Date().toISOString();
}

function dateLabel(value: string) {
  if (!value) return "Не визначено";
  return new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function daysUntil(value: string) {
  if (!value) return null;
  return Math.ceil((new Date(`${value}T23:59:59`).getTime() - Date.now()) / 86_400_000);
}

function coordinationAttentionReasons(payload: PortalPayload, node: WorkNode) {
  const reasons = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);
  if (payload.blockers.some((item) => item.nodeId === node.id && item.status === "open")) reasons.add("Відкритий блокер");
  else if (node.health === "blocked") reasons.add("Заблоковано");
  if (node.health === "risk") reasons.add("Є ризик");
  if ((payload.discussions || []).some((message) => message.nodeId === node.id && !message.deletedAt && !message.resolvedAt && message.kind === "question")) reasons.add("Питання без відповіді");
  if ((payload.discussions || []).some((message) => message.nodeId === node.id && !message.deletedAt && !message.resolvedAt && message.kind === "comment" && message.requiresResponse)) reasons.add("Коментар без відповіді");
  if (payload.decisions.some((item) => item.nodeId === node.id && item.status === "requested")) reasons.add("Рішення не прийнято");
  if (payload.acceptances.some((item) => item.nodeId === node.id && item.status === "submitted") || node.lifecycle === "acceptance") reasons.add("Результат не прийнято");
  if (node.kind === "task" && node.lifecycle === "completed" && !payload.acceptances.some((item) => item.nodeId === node.id && item.status === "accepted")) reasons.add("Завершено без приймання");
  if (node.plannedEnd && node.plannedEnd < today && !["completed", "cancelled"].includes(node.lifecycle)) reasons.add("Прострочений строк");
  if (node.kind === "cycle" && !descendants(payload.nodes.filter((item) => !item.archived), node.id).some((item) => item.kind === "task")) reasons.add("Цикл без завдань");
  return [...reasons];
}

function branchHasOpenBlocker(payload: PortalPayload, node: WorkNode) {
  const branch = descendants(payload.nodes.filter((item) => !item.archived), node.id);
  const ids = new Set(branch.map((item) => item.id));
  return branch.some((item) => item.health === "blocked" || item.health === "risk") || payload.blockers.some((blocker) => blocker.status === "open" && ids.has(blocker.nodeId));
}

const weekdayLabels = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П’ятниця", "Субота"];

function coordinationCadenceLabel(node: WorkNode) {
  if (node.coordinationStartDate && node.coordinationIntervalDays) return `${weekdayLabels[node.coordinationWeekday ?? new Date(`${node.coordinationStartDate}T12:00:00`).getDay()]} · кожні ${node.coordinationIntervalDays} дн. · з ${dateLabel(node.coordinationStartDate)}`;
  return node.coordinationCadence || "Графік не визначено";
}

function alignDateToWeekday(value: string, weekday: number) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + (weekday - date.getDay() + 7) % 7);
  return date.toISOString().slice(0, 10);
}

function stateOnly(payload: PortalPayload): PortalState {
  return {
    version: payload.version,
    revision: payload.revision,
    users: payload.users,
    nodes: payload.nodes,
    dependencies: payload.dependencies,
    blockers: payload.blockers,
    decisions: payload.decisions,
    acceptances: payload.acceptances,
    coordinations: payload.coordinations,
    discussions: payload.discussions || [],
    notifications: payload.notifications || [],
    audit: payload.audit,
    settings: payload.settings,
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function usePersistentDraft<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>, () => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const saved = window.localStorage.getItem(key);
      return saved ? JSON.parse(saved) as T : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* local drafts are best-effort */ }
  }, [key, value]);
  const clear = useCallback(() => {
    try { window.localStorage.removeItem(key); } catch { /* local drafts are best-effort */ }
  }, [key]);
  return [value, setValue, clear];
}

function nodePath(nodes: WorkNode[], node: WorkNode) {
  const path: WorkNode[] = [];
  let current: WorkNode | undefined = node;
  while (current) {
    path.unshift(current);
    current = current.parentId ? nodes.find((item) => item.id === current?.parentId) : undefined;
  }
  return path;
}

function buildAsanaDescription(payload: PortalPayload, node: WorkNode) {
  const userName = (id: string) => payload.users.find((user) => user.id === id)?.name || "Не визначено";
  const text = (value: string) => value.trim() || "Не визначено";
  const path = nodePath(payload.nodes, node).map((item) => `${item.code} · ${item.title}`).join(" → ");
  const participants = node.participantIds.map(userName).join(", ") || "Не визначено";
  const recurrence = node.recurrence.enabled ? `${node.recurrence.frequency === "weekly" ? "Щотижня" : node.recurrence.frequency === "monthly" ? "Щомісяця" : node.recurrence.frequency === "quarterly" ? "Щокварталу" : "Щороку"}${node.recurrence.interval > 1 ? ` · інтервал ${node.recurrence.interval}` : ""}${node.recurrence.nextDate ? ` · наступна дата ${dateLabel(node.recurrence.nextDate)}` : ""}` : "Немає";
  return [
    "ПАСПОРТ КАРТКИ ПОРТАЛУ",
    "",
    "МІСЦЕ В СТРУКТУРІ",
    `Шлях: ${path}`,
    `Рівень: ${kindLabels[node.kind]}`,
    `Код: ${node.code}`,
    `Назва: ${node.title}`,
    "",
    "РЕЗУЛЬТАТ І МЕЖІ",
    `Опис: ${text(node.description)}`,
    `Готовий результат: ${text(node.result)}`,
    `Що не є результатом: ${text(node.nonResult)}`,
    `Критерій приймання: ${text(node.acceptanceCriteria)}`,
    "",
    "ВІДПОВІДАЛЬНІ",
    `Координатор: ${userName(node.ownerId)}`,
    `Виконавець: ${userName(node.assigneeId)}`,
    `Керівник вищої ланки: ${userName(node.acceptorId)}`,
    `Учасники / фоловери: ${participants}`,
    "",
    "СТРОКИ ТА СТАН",
    `Дата початку: ${dateLabel(node.plannedStart)}`,
    `Дедлайн до - ${dateLabel(node.plannedEnd)}`,
    `Прогноз завершення: ${dateLabel(node.forecastEnd)}`,
    `Фактичний початок: ${dateLabel(node.actualStart)}`,
    `Фактичне завершення: ${dateLabel(node.actualEnd)}`,
    `Статус: ${lifecycleLabels[node.lifecycle]}`,
    `Стан виконання: ${healthLabels[node.health]}`,
    `Прогрес: ${node.progress}%`,
    `Пріоритет: ${priorityLabels[node.priority]}`,
    "",
    "УМОВИ ВИКОНАННЯ",
    `Спосіб початку: ${startLabels[node.startMode]}`,
    `Повноваження: ${text(node.authority)}`,
    `Ресурс: ${text(node.resource)}`,
    `Контрольне місце: ${text(node.controlPlace)}`,
    `Доступ: ${node.visibility === "company" ? "Уся компанія" : "Лише учасники"}`,
    `Повторення: ${recurrence}`,
    ...(node.kind === "cycle" ? [`Графік координації: ${coordinationCadenceLabel(node)}`] : []),
    "",
    `Оновлено в порталі: ${new Date(node.updatedAt).toLocaleString("uk-UA")}`,
  ].join("\n");
}

function descendants(nodes: WorkNode[], rootId: string) {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => ids.has(node.id));
}

function completionBlockReason(nodes: WorkNode[], node: WorkNode) {
  if (node.kind === "task") return "";
  const incomplete = nodes.filter((item) => item.parentId === node.id && !item.archived && item.lifecycle !== "cancelled" && item.lifecycle !== "completed");
  return incomplete.length ? `Спочатку завершіть нижчі рівні: ${incomplete.length}` : "";
}

function defaultAsana() {
  return {
    taskGid: "",
    taskUrl: "",
    projectGid: "",
    workspaceGid: "",
    sectionGid: "",
    lastSyncedAt: null,
    syncState: "not_linked" as const,
    remoteName: "",
    remoteCompleted: false,
    remoteDueOn: "",
    remoteAssignee: "",
    remoteFollowerCount: 0,
    rules: { title: "portal" as const, assignee: "manual" as const, dates: "manual" as const, status: "asana" as const, description: "portal" as const },
  };
}

function nextKind(parent?: WorkNode): NodeKind {
  if (!parent) return "goal";
  return parent.kind === "goal" ? "cycle" : parent.kind === "cycle" ? "subcycle" : "task";
}

function allowedParentKinds(kind: NodeKind): NodeKind[] {
  if (kind === "goal") return [];
  if (kind === "cycle") return ["goal"];
  if (kind === "subcycle") return ["cycle"];
  return ["cycle", "subcycle"];
}

function ancestorOfKinds(nodes: WorkNode[], start: WorkNode | undefined, kinds: NodeKind[]) {
  let current = start;
  while (current) {
    if (kinds.includes(current.kind)) return current;
    current = current.parentId ? nodes.find((node) => node.id === current?.parentId) : undefined;
  }
  return undefined;
}

function parentKindsLabel(kinds: NodeKind[]) {
  return kinds.map((kind) => kindLabels[kind].toLowerCase()).join(" або ");
}

function nextCode(nodes: WorkNode[], parent?: WorkNode) {
  if (!parent) return `S${nodes.filter((node) => node.kind === "goal").length + 1}`;
  if (parent.kind === "goal") return `P${nodes.filter((node) => node.kind === "cycle").length + 1}`;
  const siblings = nodes.filter((node) => node.parentId === parent.id);
  return `${parent.code}.${siblings.length + 1}`;
}

function blankNode(nodes: WorkNode[], parent: WorkNode | undefined, user: PortalUser, requestedKind?: NodeKind): WorkNode {
  const now = isoNow();
  const kind = requestedKind || nextKind(parent);
  return {
    id: crypto.randomUUID(),
    parentId: parent?.id || null,
    code: nextCode(nodes, parent),
    kind,
    title: "",
    description: "",
    result: "",
    nonResult: "",
    acceptanceCriteria: "",
    ownerId: user.id,
    assigneeId: user.id,
    acceptorId: parent?.ownerId || user.id,
    participantIds: [],
    lifecycle: "draft",
    lifecycleOverride: undefined,
    health: "normal",
    decisionRequired: false,
    priority: "normal",
    plannedStart: "",
    plannedEnd: "",
    forecastEnd: "",
    actualStart: "",
    actualEnd: "",
    progress: 0,
    weight: 10,
    startMode: parent ? "with_parent" : "fixed_date",
    resource: "",
    authority: "",
    coordinationCadence: kind === "cycle" ? "Щотижня" : "",
    coordinationStartDate: "",
    coordinationIntervalDays: 7,
    coordinationWeekday: 1,
    controlPlace: "",
    visibility: "company",
    archived: false,
    evidence: [],
    updates: [],
    recurrence: { enabled: false, frequency: "monthly", interval: 1, nextDate: "" },
    asana: defaultAsana(),
    createdAt: now,
    updatedAt: now,
  };
}

function recalculateHierarchy(state: PortalState) {
  const active = state.nodes.filter((node) => !node.archived);
  const depth = (node: WorkNode) => {
    let value = 0;
    let current = node;
    while (current.parentId) {
      value += 1;
      const parent = state.nodes.find((item) => item.id === current.parentId);
      if (!parent) break;
      current = parent;
    }
    return value;
  };
  const parents = active.filter((node) => node.kind !== "task").sort((a, b) => depth(b) - depth(a));
  for (const parent of parents) {
    const children = active.filter((node) => node.parentId === parent.id);
    if (!children.length) continue;
    const before = JSON.stringify({ progress: parent.progress, health: parent.health, decisionRequired: parent.decisionRequired, lifecycle: parent.lifecycle, forecastEnd: parent.forecastEnd });
    const totalWeight = children.reduce((sum, child) => sum + Math.max(1, child.weight || 1), 0);
    parent.progress = Math.round(children.reduce((sum, child) => sum + child.progress * Math.max(1, child.weight || 1), 0) / totalWeight);
    parent.health = state.blockers.some((item) => item.nodeId === parent.id && item.status === "open") ? "blocked" : "normal";
    parent.decisionRequired = state.decisions.some((item) => item.nodeId === parent.id && item.status === "requested");
    const meaningful = children.filter((child) => child.lifecycle !== "cancelled");
    if (parent.lifecycleOverride) parent.lifecycle = parent.lifecycleOverride;
    else if (meaningful.length && meaningful.every((child) => child.lifecycle === "completed")) parent.lifecycle = "completed";
    else if (meaningful.some((child) => ["in_progress", "acceptance", "completed"].includes(child.lifecycle))) parent.lifecycle = "in_progress";
    else if (meaningful.length && meaningful.every((child) => child.lifecycle === "ready")) parent.lifecycle = "ready";
    else if (meaningful.length && meaningful.every((child) => child.lifecycle === "paused")) parent.lifecycle = "paused";
    else parent.lifecycle = "planned";
    const forecasts = children.map((child) => child.forecastEnd || child.plannedEnd).filter(Boolean).sort();
    if (forecasts.length) parent.forecastEnd = forecasts.at(-1) || parent.forecastEnd;
    const after = JSON.stringify({ progress: parent.progress, health: parent.health, decisionRequired: parent.decisionRequired, lifecycle: parent.lifecycle, forecastEnd: parent.forecastEnd });
    if (before !== after) parent.updatedAt = isoNow();
  }
}

function ProgressRing({ value, label }: { value: number; label?: string }) {
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="progress-ring" style={{ "--progress": `${safe * 3.6}deg` } as React.CSSProperties} aria-label={`Прогрес ${safe}%`}>
      <div><strong>{safe}%</strong>{label && <span>{label}</span>}</div>
    </div>
  );
}

function UserAvatar({ user, compact = false }: { user?: PortalUser; compact?: boolean }) {
  if (!user) return <span className="avatar empty">?</span>;
  const initials = user.name.split(" ").slice(0, 2).map((part) => part[0]).join("");
  return <span className={`avatar ${compact ? "compact" : ""}`} style={{ background: user.color }} title={user.name}>{initials}</span>;
}

function StatusBadge({ node }: { node: WorkNode }) {
  return <span className={`health-badge ${node.health}`}>{node.health === "normal" ? lifecycleLabels[node.lifecycle] : healthLabels[node.health]}</span>;
}

function LoginScreen({ initialError }: { initialError?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError || "");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Не вдалося увійти");
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не вдалося увійти");
      setBusy(false);
    }
  };
  return <div className="login-screen"><form className="login-card" onSubmit={(event) => void submit(event)} noValidate><div className="loading-mark logo"><img src="/pravdop-logo.png" alt="Правова Допомога" width={145} height={48} /></div><span>Захищений доступ</span><h1>Управлінський портал</h1><p>Увійдіть за корпоративною адресою, для якої адміністратор надав доступ.</p><label className={error ? "has-error" : ""}><b>Корпоративна адреса <i className="required-mark">*</i></b><input type="email" autoComplete="username" value={email} onChange={(event) => { setEmail(event.target.value); setError(""); }} placeholder="Наприклад: name@pravdop.com" required aria-invalid={Boolean(error)} /></label><label className={error ? "has-error" : ""}><b>Пароль <i className="required-mark">*</i></b><input type="password" autoComplete="current-password" value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} placeholder="Введіть виданий адміністратором пароль" required aria-invalid={Boolean(error)} /></label>{error && <div className="login-error" role="alert">{error}</div>}<button type="submit" disabled={busy}>{busy ? "Перевіряємо…" : "Увійти"}</button><small><i className="required-mark">*</i> — обов’язкові поля. Права доступу та паролі користувачів керуються в налаштуваннях порталу.</small></form></div>;
}

export function PortalApp() {
  const [payload, setPayload] = useState<PortalPayload | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [draftNode, setDraftNode] = useState<WorkNode | null>(null);
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<"all" | HealthStatus | "overdue" | "decision">("all");
  const [workEntryFilter, setWorkEntryFilter] = useState<WorkFilter>("action");
  const [workEntryFocus, setWorkEntryFocus] = useState<WorkFocus>(null);
  const [notice, setNoticeState] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("success");
  const [nodeErrors, setNodeErrors] = useState<NodeErrors>({});
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [locks, setLocks] = useState<EditingLock[]>([]);
  const [editingEntityId, setEditingEntityId] = useState("");
  const [asanaStatus, setAsanaStatus] = useState<{ configured: boolean; connected: boolean; connection?: Record<string, string> } | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const payloadRef = useRef<PortalPayload | null>(null);
  const savingRef = useRef(false);
  const draftNodeRef = useRef<WorkNode | null>(null);
  const restoredDraftRef = useRef(false);
  const urlSyncReadyRef = useRef(false);
  const sidebarReadyRef = useRef(false);

  const setNotice = useCallback<Notify>((value, tone = "success") => {
    setNoticeState(value);
    setNoticeTone(tone);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(""), noticeTone === "error" ? 7000 : 3500);
    return () => window.clearTimeout(timer);
  }, [notice, noticeTone]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("portal:sidebar-collapsed");
      // Device-local navigation preference is restored after hydration.
      if (saved !== null) setSidebarCollapsed(saved === "true");
    } finally {
      sidebarReadyRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!sidebarReadyRef.current) return;
    try { window.localStorage.setItem("portal:sidebar-collapsed", String(sidebarCollapsed)); } catch { /* preference is best-effort */ }
  }, [sidebarCollapsed]);

  const fetchPayload = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "Не вдалося завантажити портал");
    const data = (await response.json()) as PortalPayload;
    const normalized = stateOnly(data);
    recalculateHierarchy(normalized);
    return { ...data, ...normalized };
  }, []);

  const applyPayload = useCallback((data: PortalPayload) => {
    payloadRef.current = data;
    setPayload(data);
  }, []);

  const load = useCallback(async () => {
    const data = await fetchPayload();
    applyPayload(data);
    return data;
  }, [applyPayload, fetchPayload]);

  useEffect(() => {
    // Initial API hydration is the intended external synchronization for this client shell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
      .then((data) => {
        const requestedView = new URLSearchParams(window.location.search).get("view") as View | null;
        if (requestedView && nav.some((item) => item.id === requestedView)) setView(requestedView);
        const requestedNode = new URLSearchParams(window.location.search).get("node");
        if (requestedNode && data.nodes.some((node) => node.id === requestedNode && !node.archived)) setSelectedId(requestedNode);
        window.requestAnimationFrame(() => { urlSyncReadyRef.current = true; });
      })
      .catch((error) => setLoadError(error.message));
  }, [load]);

  useEffect(() => { payloadRef.current = payload; }, [payload]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => { draftNodeRef.current = draftNode; }, [draftNode]);

  useEffect(() => {
    if (!payload || !urlSyncReadyRef.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    if (selectedId && payload.nodes.some((node) => node.id === selectedId && !node.archived)) url.searchParams.set("node", selectedId);
    else url.searchParams.delete("node");
    if (`${url.pathname}${url.search}` !== `${window.location.pathname}${window.location.search}`) window.history.pushState({ view, node: selectedId }, "", `${url.pathname}${url.search}`);
  }, [payload, selectedId, view]);

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const requestedView = params.get("view") as View | null;
      if (requestedView && nav.some((item) => item.id === requestedView)) setView(requestedView);
      const requestedNode = params.get("node");
      if (requestedNode && payloadRef.current?.nodes.some((node) => node.id === requestedNode && !node.archived)) setSelectedId(requestedNode);
      else setSelectedId("");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!payload?.currentUser.id || restoredDraftRef.current) return;
    restoredDraftRef.current = true;
    try {
      const saved = window.localStorage.getItem(`portal:node-draft:${payload.currentUser.id}`);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { node?: WorkNode; savedAt?: string };
      if (!parsed.node || !parsed.savedAt || Date.now() - new Date(parsed.savedAt).getTime() > 7 * 86_400_000) return;
      // Restore is intentionally triggered by external browser storage.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraftNode(parsed.node);
      setModal("node");
      setNotice("Відновлено незбережену картку після оновлення сторінки");
    } catch { /* ignore an invalid local draft */ }
  }, [payload?.currentUser.id, setNotice]);

  useEffect(() => {
    if (!payload?.currentUser.id || modal !== "node" || !draftNode) return;
    try { window.localStorage.setItem(`portal:node-draft:${payload.currentUser.id}`, JSON.stringify({ node: draftNode, savedAt: isoNow() })); } catch { /* local draft is best-effort */ }
  }, [draftNode, modal, payload?.currentUser.id]);

  const currentUserId = payload?.currentUser.id;
  const refreshLocks = useCallback(async () => {
    const response = await fetch("/api/locks", { cache: "no-store" });
    if (!response.ok) return [];
    const result = (await response.json()) as { locks?: EditingLock[] };
    const next = result.locks || [];
    setLocks(next);
    return next;
  }, []);

  const acquireLock = useCallback(async (entityId: string) => {
    const response = await fetch("/api/locks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "acquire", entityId }) });
    const result = (await response.json()) as { error?: string; lock?: EditingLock };
    if (!response.ok) throw new Error(result.error || "Не вдалося відкрити картку для редагування");
    setEditingEntityId(entityId);
    await refreshLocks();
  }, [refreshLocks]);

  const releaseLock = useCallback(async (entityId = editingEntityId) => {
    if (!entityId) return;
    setEditingEntityId("");
    await fetch("/api/locks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "release", entityId }), keepalive: true }).catch(() => undefined);
    await refreshLocks();
  }, [editingEntityId, refreshLocks]);

  useEffect(() => {
    if (!currentUserId) return;
    // Initial lock hydration synchronizes this client with collaborative state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshLocks();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || savingRef.current) return;
      void Promise.all([fetchPayload(), refreshLocks()]).then(([latest]) => {
        const current = payloadRef.current;
        if (!current || latest.revision <= current.revision) return;
        applyPayload(latest);
        setNotice("Дані автоматично оновлено після змін іншого користувача");
      }).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [applyPayload, currentUserId, fetchPayload, refreshLocks, setNotice]);

  useEffect(() => {
    if (!editingEntityId) return;
    const heartbeat = () => fetch("/api/locks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "heartbeat", entityId: editingEntityId }) }).then(() => refreshLocks()).catch(() => undefined);
    const timer = window.setInterval(() => void heartbeat(), 30_000);
    return () => window.clearInterval(timer);
  }, [editingEntityId, refreshLocks]);

  useEffect(() => {
    if (modal !== "node" || !draftNode || editingEntityId || !payload?.nodes.some((node) => node.id === draftNode.id)) return;
    // A restored draft must reacquire its server-side editing lease.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void acquireLock(draftNode.id).catch((cause) => {
      setModal(null);
      setDraftNode(null);
      setNotice(cause instanceof Error ? cause.message : "Цю картку вже редагують", "error");
    });
  }, [acquireLock, draftNode, editingEntityId, modal, payload?.nodes, setNotice]);

  useEffect(() => {
    if (!currentUserId) return;
    fetch("/api/asana/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ configured: boolean; connected: boolean; connection?: Record<string, string> }>)
      .then(setAsanaStatus)
      .catch(() => setAsanaStatus({ configured: false, connected: false }));
    fetch("/api/telegram/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<TelegramStatus>)
      .then(setTelegramStatus)
      .catch(() => setTelegramStatus({ configured: false, connected: false, error: "Не вдалося перевірити Telegram" }));
  }, [currentUserId]);

  const mutate = useCallback(async (action: string, entityId: string, recipe: (state: PortalState) => void) => {
    let base = payloadRef.current;
    if (!base) return false;
    setSaving(true);
    setNotice("");
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const next = deepClone(stateOnly(base));
        recipe(next);
        recalculateHierarchy(next);
        const response = await fetch("/api/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: next, expectedRevision: base.revision, action, entityId }),
        });
        const body = (await response.json()) as PortalPayload & { error?: string };
        if (response.ok) {
          applyPayload(body as PortalPayload);
          setNotice(attempt ? "Зміни об’єднано з новішою редакцією та збережено" : "Зміни збережено");
          return true;
        }
        if (response.status === 409 && attempt === 0) {
          base = await fetchPayload();
          applyPayload(base);
          continue;
        }
        throw new Error(body.error || "Не вдалося зберегти зміни");
      }
      return false;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Помилка збереження", "error");
      return false;
    } finally {
      setSaving(false);
    }
  }, [applyPayload, fetchPayload, setNotice]);

  const data = useMemo(() => {
    if (!payload) return null;
    const activeNodes = payload.nodes.filter((node) => !node.archived);
    const tasks = activeNodes.filter((node) => node.kind === "task");
    const today = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter((node) => node.lifecycle !== "completed" && node.plannedEnd && node.plannedEnd < today);
    const blocked = activeNodes.filter((node) => node.health === "blocked");
    const decisions = payload.decisions.filter((item) => item.status === "requested");
    const completed = tasks.filter((node) => node.lifecycle === "completed");
    const accepted = payload.acceptances.filter((item) => item.status === "accepted");
    const returned = payload.acceptances.filter((item) => item.status === "returned");
    return {
      activeNodes,
      tasks,
      goals: activeNodes.filter((node) => node.kind === "goal"),
      subcycles: activeNodes.filter((node) => node.kind === "subcycle"),
      overdue,
      blocked,
      decisions,
      completed,
      onTimeRate: completed.length ? Math.round(completed.filter((node) => !node.plannedEnd || node.actualEnd <= node.plannedEnd).length / completed.length * 100) : 0,
      firstPassRate: accepted.length ? Math.round(accepted.filter((item) => item.attempt === 1).length / accepted.length * 100) : 0,
      returnedCount: returned.length,
    };
  }, [payload]);

  if (!payload || !data) return loadError ? <LoginScreen initialError={loadError.startsWith("Потрібен вхід") ? "" : loadError} /> : <div className="loading-screen"><div className="loading-mark logo"><img src="/pravdop-logo.png" alt="Правова Допомога" width={145} height={48} /></div><strong>Готуємо управлінський портал…</strong></div>;

  const userById = (id: string) => payload.users.find((user) => user.id === id);
  const unreadNotificationCount = (payload.notifications || []).filter((item) => item.userId === payload.currentUser.id && !item.readAt).length;
  const selected = payload.nodes.find((node) => node.id === selectedId && !node.archived) || payload.nodes.find((node) => !node.archived);
  const canManage = ["owner", "admin", "goal_owner", "cycle_owner", "coordinator"].includes(payload.currentUser.role);
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); };
  const copyNodeLink = async (node: WorkNode, targetView: View) => {
    const url = new URL(window.location.origin);
    url.searchParams.set("view", targetView);
    url.searchParams.set("node", node.id);
    try {
      await navigator.clipboard.writeText(url.toString());
      setNotice(`Посилання на ${node.code} скопійовано`);
    } catch {
      setNotice("Не вдалося скопіювати посилання", "error");
    }
  };
  const clearNodeLocalDraft = () => {
    try { window.localStorage.removeItem(`portal:node-draft:${payload.currentUser.id}`); } catch { /* local draft is best-effort */ }
  };
  const closeNodeEditor = () => {
    clearNodeLocalDraft();
    setModal(null);
    setDraftNode(null);
    void releaseLock();
  };

  const openCreateKind = (kind: NodeKind, context?: WorkNode) => {
    const allowedParents = allowedParentKinds(kind);
    const parent = allowedParents.length ? ancestorOfKinds(payload.nodes, context || selected, allowedParents) : undefined;
    if (allowedParents.length && !parent) {
      setNotice(`Спочатку створіть ${parentKindsLabel(allowedParents)}`, "error");
      return;
    }
    setNodeErrors({});
    setDraftNode(blankNode(payload.nodes, parent, payload.currentUser, kind));
    setModal("node");
  };

  const openEdit = async (node: WorkNode) => {
    try {
      await acquireLock(node.id);
      setNodeErrors({});
      setDraftNode(deepClone(node));
      setModal("node");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Цю картку вже редагують", "error");
    }
  };

  const saveNode = async () => {
    if (!draftNode) return;
    const errors: NodeErrors = {};
    if (!draftNode.code.trim()) errors.code = "Вкажіть унікальний код.";
    if (!draftNode.title.trim()) errors.title = "Вкажіть коротку й однозначну назву.";
    if (!draftNode.result.trim()) errors.result = "Опишіть перевірюваний готовий результат.";
    if (!draftNode.ownerId) errors.ownerId = "Оберіть координатора.";
    if (!draftNode.assigneeId) errors.assigneeId = "Оберіть виконавця або координатора.";
    if (!draftNode.acceptorId) errors.acceptorId = "Оберіть керівника вищої ланки.";
    if (draftNode.lifecycleOverride === "completed" && completionBlockReason(payload.nodes, draftNode)) errors.lifecycle = completionBlockReason(payload.nodes, draftNode);
    if (Object.keys(errors).length) {
      setNodeErrors(errors);
      setNotice("Не вдалося зберегти: перевірте виділені обов’язкові поля.", "error");
      window.requestAnimationFrame(() => (document.querySelector(".field-error input, .field-error textarea, .field-error select") as HTMLElement | null)?.focus());
      return;
    }
    if (payload.nodes.some((node) => node.code.toLowerCase() === draftNode.code.trim().toLowerCase() && node.id !== draftNode.id)) {
      setNodeErrors({ code: "Такий код уже використовується." });
      setNotice("Не вдалося зберегти: код має бути унікальним.", "error");
      return;
    }
    const allowedParents = allowedParentKinds(draftNode.kind);
    const parent = draftNode.parentId ? payload.nodes.find((node) => node.id === draftNode.parentId) : undefined;
    if ((allowedParents.length && (!parent || !allowedParents.includes(parent.kind))) || (!allowedParents.length && draftNode.parentId)) {
      setNodeErrors({ parentId: "Оберіть коректний батьківський рівень." });
      setNotice("Не вдалося зберегти: перевірте місце об’єкта в дереві.", "error");
      return;
    }
    const exists = payload.nodes.some((node) => node.id === draftNode.id);
    const updated = { ...draftNode, updatedAt: isoNow() };
    const ok = await mutate(exists ? `Оновлено ${draftNode.code}` : `Створено ${draftNode.code}`, draftNode.id, (state) => {
      const index = state.nodes.findIndex((node) => node.id === updated.id);
      if (index >= 0) state.nodes[index] = updated;
      else state.nodes.push(updated);
    });
    if (ok) {
      setNodeErrors({});
      setSelectedId(draftNode.id);
      clearNodeLocalDraft();
      setModal(null);
      setDraftNode(null);
      await releaseLock();
    }
  };

  const submitAcceptance = (node: WorkNode, acceptorId: string, evidenceNote: string) => mutate(`Завершення ${node.code} передано на приймання`, node.id, (state) => {
    const prior = state.acceptances.filter((item) => item.nodeId === node.id).length;
    state.acceptances.unshift({
      id: crypto.randomUUID(), nodeId: node.id, submittedBy: payload.currentUser.id, acceptorId,
      evidenceNote: evidenceNote.trim() || node.evidence.map((item) => item.label).join(", "), status: "submitted", feedback: "",
      submittedAt: isoNow(), decidedAt: "", attempt: prior + 1,
    });
    const target = state.nodes.find((item) => item.id === node.id)!;
    target.acceptorId = acceptorId;
    target.lifecycle = "acceptance";
    target.updatedAt = isoNow();
    const acceptance = state.acceptances[0];
    state.discussions.unshift({ id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, recipientId: acceptorId, relatedType: "acceptance", relatedId: acceptance.id, text: `Виконавець завершив завдання та передав результат на приймання керівнику вищої ланки: ${payload.users.find((user) => user.id === acceptorId)?.name || "не визначено"}. Критерій: ${node.acceptanceCriteria || "не визначено"}.${evidenceNote.trim() ? ` Докази: ${evidenceNote.trim()}` : ""}`, kind: "approval", createdAt: isoNow() });
  });

  const resolveAcceptance = (acceptance: Acceptance, accepted: boolean, feedback = "") => mutate(
    accepted ? "Результат прийнято" : "Результат повернуто на доопрацювання",
    acceptance.nodeId,
    (state) => {
      const item = state.acceptances.find((candidate) => candidate.id === acceptance.id)!;
      item.status = accepted ? "accepted" : "returned";
      item.decidedAt = isoNow();
      item.feedback = feedback.trim() || (accepted ? "Результат відповідає критерію приймання" : "Потрібне доопрацювання за коментарем відповідального");
      const node = state.nodes.find((candidate) => candidate.id === acceptance.nodeId)!;
      node.lifecycle = accepted ? "completed" : "in_progress";
      if (accepted) {
        node.progress = 100;
        node.actualEnd = isoNow().slice(0, 10);
        node.health = "normal";
      }
      state.discussions.unshift({ id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, recipientId: acceptance.submittedBy, relatedType: "acceptance", relatedId: acceptance.id, text: `${accepted ? "Результат прийнято" : "Результат повернуто на доопрацювання"}. ${item.feedback}`, kind: "approval", createdAt: isoNow() });
    },
  );

  const saveWorkUpdate = (node: WorkNode, update: Omit<WorkUpdate, "id" | "createdAt" | "createdBy" | "source">) => mutate(
    `${node.code}: подано робочий звіт`,
    node.id,
    (state) => {
      const target = state.nodes.find((item) => item.id === node.id)!;
      target.lifecycle = update.lifecycle;
      target.health = update.health;
      target.progress = Math.max(0, Math.min(100, update.progress));
      target.forecastEnd = update.forecastEnd;
      target.updatedAt = isoNow();
      if (update.lifecycle === "in_progress" && !target.actualStart) target.actualStart = isoNow().slice(0, 10);
      if (update.lifecycle === "completed") {
        target.progress = 100;
        target.actualEnd = isoNow().slice(0, 10);
      }
      target.updates = [
        {
          ...update,
          progress: target.progress,
          id: crypto.randomUUID(),
          createdAt: isoNow(),
          createdBy: payload.currentUser.id,
          source: "portal",
        },
        ...(target.updates || []),
      ];
    },
  );

  const completeNode = async (node: WorkNode) => {
    const live = payloadRef.current?.nodes.find((item) => item.id === node.id) || node;
    if (live.kind === "task") {
      if (live.lifecycle === "acceptance") { setNotice("Завершення вже передано керівнику вищої ланки на приймання", "error"); return false; }
      return submitAcceptance(live, live.acceptorId, live.evidence.map((item) => item.label).join(", "));
    }
    const children = (payloadRef.current?.nodes || []).filter((item) => item.parentId === live.id && !item.archived && item.lifecycle !== "cancelled");
    const incomplete = children.filter((item) => item.lifecycle !== "completed");
    if (live.kind !== "task" && incomplete.length) {
      setNotice(`Неможливо завершити ${kindLabels[live.kind].toLowerCase()}: ${incomplete.length} нижчих рівнів ще не завершено.`, "error");
      return false;
    }
    return mutate(`Завершено ${live.code}`, live.id, (state) => {
      const target = state.nodes.find((item) => item.id === live.id)!;
      target.lifecycle = "completed";
      target.progress = 100;
      target.actualEnd = isoNow().slice(0, 10);
      target.health = "normal";
      target.updatedAt = isoNow();
      target.updates = [{ id: crypto.randomUUID(), lifecycle: "completed", health: "normal", progress: 100, forecastEnd: target.forecastEnd, summary: `${kindLabels[target.kind]} завершено`, nextAction: "", createdAt: isoNow(), createdBy: payload.currentUser.id, source: "portal" }, ...(target.updates || [])];
      state.discussions.unshift({ id: crypto.randomUUID(), nodeId: target.id, authorId: payload.currentUser.id, text: `${kindLabels[target.kind]} позначено завершеним.`, kind: "system", createdAt: isoNow() });
    });
  };

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">Перейти до основного вмісту</a>
      {notice && <div className={`global-notice ${noticeTone}`} role={noticeTone === "error" ? "alert" : "status"} aria-live={noticeTone === "error" ? "assertive" : "polite"}><span>{noticeTone === "error" ? "!" : "✓"}</span><strong>{notice}</strong><button type="button" onClick={() => setNoticeState("")} aria-label="Закрити повідомлення">×</button></div>}
      {saving && <span className="saving-floating" role="status">Зберігаємо…</span>}
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-logo"><img src="/pravdop-logo.png" alt="Правова Допомога" width={145} height={48} /></div>
          <div><strong>Управлінський портал</strong><span>{payload.settings.organizationName}</span></div>
          <button className="sidebar-toggle" type="button" aria-label={sidebarCollapsed ? "Розгорнути бічне меню" : "Згорнути бічне меню"} title={sidebarCollapsed ? "Розгорнути меню" : "Згорнути меню"} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? "›" : "‹"}</button>
        </div>
        <nav aria-label="Основна навігація">
          {nav.map((item) => (
            <button key={item.id} className={`nav-item nav-${item.id} ${view === item.id ? "active" : ""}`} title={item.label} onClick={() => { if (item.id === "my") { setWorkEntryFilter("action"); setWorkEntryFocus(null); } setView(item.id); }}>
              <span className="nav-mark" aria-hidden="true">{item.icon}</span><span><strong>{item.label}{item.id === "inbox" && unreadNotificationCount > 0 && <b className="nav-unread">{unreadNotificationCount}</b>}</strong><small>{item.hint}</small></span>
            </button>
          ))}
          <details className="mobile-more-nav"><summary><span aria-hidden="true">•••</span><strong>Ще</strong></summary><div>{nav.filter((item) => ["calendar", "coordination", "settings"].includes(item.id)).map((item) => <button key={item.id} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setView(item.id); }}><span aria-hidden="true">{item.icon}</span><strong>{item.label}</strong></button>)}<div className="mobile-account"><UserAvatar user={payload.currentUser} compact /><span><strong>{payload.currentUser.name}</strong><small>{roleLabels[payload.currentUser.role]}</small></span><button type="button" onClick={() => void logout()}>Вийти</button></div></div></details>
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-account"><UserAvatar user={payload.currentUser} compact /><div><strong>{payload.currentUser.name}</strong><small>{roleLabels[payload.currentUser.role]}</small></div><button type="button" onClick={() => void logout()} aria-label="Вийти з порталу" title="Вийти">↪</button></div>
          <div className="sidebar-system"><span className={`system-dot ${payload.storage}`} /><div><strong>{payload.storage === "database" ? "Дані зберігаються" : "Тестовий режим"}</strong><small>Редакція {payload.revision}</small></div></div>
        </div>
      </aside>

      <section className="workspace">
        <div className="content" id="main-content">
          {view === "dashboard" && <DashboardView data={data} payload={payload} userById={userById} healthFilter={healthFilter} setHealthFilter={setHealthFilter} select={(id) => { setSelectedId(id); setView("tree"); }} openWork={(id) => { setSelectedId(id); setWorkEntryFilter("all"); setWorkEntryFocus(null); setView("my"); }} />}
          {view === "inbox" && <NotificationsView payload={payload} userById={userById} mutate={mutate} openNode={(id, nextFilter, focus) => { setSelectedId(id); setWorkEntryFilter(nextFilter); setWorkEntryFocus(focus); setView("my"); }} />}
          {view === "calendar" && <CalendarView payload={payload} userById={userById} openNode={(id) => { setSelectedId(id); setView("my"); }} />}
          {view === "tree" && (
            <TreeView
              payload={payload} selected={selected} selectedId={selectedId} setSelectedId={setSelectedId}
              search={search} setSearch={setSearch} userById={userById} canManage={canManage}
              locks={locks}
              openCreateKind={openCreateKind} openEdit={openEdit}
              openWork={(node) => { setSelectedId(node.id); setView("my"); }}
              mutate={mutate} copyNodeLink={copyNodeLink}
            />
          )}
          {view === "my" && <MyWork key={`${selected?.id || "empty"}-${workEntryFilter}-${workEntryFocus || "top"}`} payload={payload} selected={selected} selectedId={selectedId} setSelectedId={setSelectedId} initialFilter={workEntryFilter} focusTarget={workEntryFocus} userById={userById} canManage={canManage} saveWorkUpdate={saveWorkUpdate} resolveAcceptance={resolveAcceptance} completeNode={completeNode} openEdit={openEdit} copyNodeLink={copyNodeLink} setModal={setModal} asanaStatus={asanaStatus} mutate={mutate} setNotice={setNotice} openTree={(id) => { setSelectedId(id); setView("tree"); }} />}
          {view === "coordination" && <CoordinationView payload={payload} userById={userById} select={(id) => { setSelectedId(id); setView("tree"); }} open={(node) => { setSelectedId(node.id); setModal("coordination"); }} />}
          {view === "settings" && <SettingsView payload={payload} asanaStatus={asanaStatus} telegramStatus={telegramStatus} setTelegramStatus={setTelegramStatus} setNotice={setNotice} reload={load} />}
        </div>
      </section>

      {modal === "node" && draftNode && <NodeModal node={draftNode} setNode={setDraftNode} nodes={payload.nodes} users={payload.users} errors={nodeErrors} clearError={(key) => setNodeErrors((current) => ({ ...current, [key]: undefined }))} close={closeNodeEditor} save={saveNode} />}
      {modal === "blocker" && selected && <BlockerModal node={selected} users={payload.users} currentUserId={payload.currentUser.id} notify={setNotice} close={() => setModal(null)} save={async (blocker) => { const ok = await mutate(`Додано блокер до ${selected.code}`, selected.id, (state) => { state.blockers.unshift(blocker); const target = state.nodes.find((node) => node.id === selected.id)!; target.health = "blocked"; target.decisionRequired = true; }); if (ok) setModal(null); }} />}
      {modal === "decision" && selected && <DecisionModal node={selected} users={payload.users} currentUserId={payload.currentUser.id} notify={setNotice} close={() => setModal(null)} save={async (decision) => { const ok = await mutate(`Запитано рішення для ${selected.code}`, selected.id, (state) => { state.decisions.unshift(decision); state.nodes.find((node) => node.id === selected.id)!.decisionRequired = true; state.discussions.unshift({ id: crypto.randomUUID(), nodeId: selected.id, authorId: payload.currentUser.id, recipientId: decision.decisionOwnerId, relatedType: "decision", relatedId: decision.id, text: `Потрібне рішення: ${decision.question}\nВаріанти: ${decision.options || "не задані"}\nРекомендація: ${decision.recommendation || "не задана"}\nСтрок: ${dateLabel(decision.dueDate)}`, kind: "decision", createdAt: isoNow() }); }); if (ok) setModal(null); }} />}
      {modal === "coordination" && selected?.kind === "cycle" && <CoordinationModal node={selected} payload={payload} currentUserId={payload.currentUser.id} notify={setNotice} close={() => setModal(null)} save={async (snapshot) => { const ok = await mutate(`Зафіксовано координацію циклу ${selected.code}`, selected.id, (state) => state.coordinations.unshift(snapshot)); if (ok) setModal(null); }} />}
      {modal === "dependency" && selected?.kind === "task" && <DependencyModal node={selected} payload={payload} currentUserId={payload.currentUser.id} notify={setNotice} close={() => setModal(null)} save={async (dependency) => { const ok = await mutate(`Додано залежність для ${selected.code}`, selected.id, (state) => state.dependencies.push(dependency)); if (ok) setModal(null); }} />}
      {modal === "evidence" && selected && <EvidenceModal node={selected} currentUser={payload.currentUser} notify={setNotice} close={() => setModal(null)} save={async (evidence) => { const ok = await mutate(`Додано доказ до ${selected.code}`, selected.id, (state) => state.nodes.find((node) => node.id === selected.id)!.evidence.push(evidence)); if (ok) setModal(null); }} />}
    </main>
  );
}

type ComputedData = { activeNodes: WorkNode[]; tasks: WorkNode[]; goals: WorkNode[]; subcycles: WorkNode[]; overdue: WorkNode[]; blocked: WorkNode[]; decisions: Decision[]; completed: WorkNode[]; onTimeRate: number; firstPassRate: number; returnedCount: number };

function PageIntro({ kicker, title, text, actions }: { kicker: string; title: string; text: string; actions?: React.ReactNode }) {
  return <div className="page-intro"><div><span>{kicker}</span><h1>{title}</h1><p>{text}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>;
}

function DashboardView({ data, payload, userById, healthFilter, setHealthFilter, select, openWork }: { data: ComputedData; payload: PortalPayload; userById: (id: string) => PortalUser | undefined; healthFilter: "all" | HealthStatus | "overdue" | "decision"; setHealthFilter: (value: "all" | HealthStatus | "overdue" | "decision") => void; select: (id: string) => void; openWork: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [ownerId, setOwnerId] = useState("all");
  const firstGoal = data.goals[0];
  const coordination = data.activeNodes.find((node) => node.kind === "cycle");
  const coordinationTasks = coordination ? descendants(payload.nodes, coordination.id).filter((node) => node.kind === "task" && !node.archived) : [];
  const attention = data.tasks.filter((node) => node.health !== "normal" || data.overdue.some((item) => item.id === node.id));
  const openRegister = (filter: "all" | HealthStatus | "overdue" | "decision") => { setHealthFilter(filter); window.requestAnimationFrame(() => document.getElementById("control-register")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  return <>
    <PageIntro kicker="Єдиний керівницький екран" title="Результати, стани та управлінська реакція" text="Цілі, строки, блокери, рішення і навантаження зведені в одному дашборді. Детальна робота виконується в розділі «Моя робота»." />
    <div className="metric-grid">
      <button className="metric primary" onClick={() => firstGoal ? select(firstGoal.id) : openRegister("all")}><span>Стратегічні цілі</span><strong>{data.goals.length}</strong><small>{data.goals.filter((node) => node.health !== "normal").length} потребують уваги</small></button>
      <button className="metric" onClick={() => openRegister("all")}><span>Активні завдання</span><strong>{data.tasks.filter((node) => !["completed", "cancelled"].includes(node.lifecycle)).length}</strong><small>{data.tasks.filter((node) => node.lifecycle === "acceptance").length} на прийманні</small></button>
      <button className="metric danger" onClick={() => openRegister("blocked")}><span>Блокери</span><strong>{payload.blockers.filter((item) => item.status === "open").length}</strong><small>{data.decisions.length} рішень очікуються</small></button>
      <button className="metric warning" onClick={() => openRegister("overdue")}><span>Прострочені</span><strong>{data.overdue.length}</strong><small>за плановою датою</small></button>
    </div>
    <div className="overview-grid">
      <section className="panel goals-panel">
        <div className="panel-head"><div><span>01 / Цілі</span><h2>Стан стратегічних цілей</h2></div><button disabled={!firstGoal} onClick={() => firstGoal && select(firstGoal.id)}>Відкрити дерево</button></div>
        <div className="goal-list">
          {data.goals.map((goal) => {
            const branch = descendants(payload.nodes, goal.id);
            const branchTasks = branch.filter((node) => node.kind === "task");
            return <button key={goal.id} className="goal-card" onClick={() => select(goal.id)}>
              <div className="goal-code">{goal.code}</div><div className="goal-copy"><span>{goal.title}</span><h3>{goal.result}</h3><div className="goal-meta"><UserAvatar user={userById(goal.ownerId)} compact /><small>{userById(goal.ownerId)?.name}</small><i /> <small>{branchTasks.length} завдань</small></div></div><ProgressRing value={goal.progress} />
            </button>;
          })}
          {!data.goals.length && <p className="empty-state padded">Стратегічних цілей ще немає. Створіть першу ціль у дереві.</p>}
        </div>
      </section>
      <section className="panel attention-panel">
        <div className="panel-head"><div><span>02 / Реакція</span><h2>Потребують уваги</h2></div></div>
        <div className="attention-list">
          {attention.slice(0, 6).map((node) => <button key={node.id} onClick={() => openWork(node.id)}><span className={`signal ${node.health}`} /><div><strong>{node.code} · {node.title}</strong><small>{node.health === "blocked" ? "Заблоковано" : node.health === "risk" ? "Є ризик виконання" : `Строк ${dateLabel(node.plannedEnd)}`}</small></div><b>→</b></button>)}
          {!attention.length && <p className="empty-state">Критичних відхилень немає.</p>}
        </div>
      </section>
    </div>
    <section className="panel cadence-strip">
      <div><span>Найближча координація циклу</span><strong>{coordination ? `${coordination.code} · ${coordination.title}` : "Управлінських циклів ще немає"}</strong><small>{coordination ? "Предмет координації — зведений стан усіх завдань циклу з відображенням підциклів." : "Після створення циклу тут з’явиться його зведений стан."}</small></div>
      <div className="cadence-stat"><strong>{coordinationTasks.filter((node) => node.lifecycle === "in_progress").length}</strong><span>у роботі</span></div>
      <div className="cadence-stat red"><strong>{coordinationTasks.filter((node) => payload.blockers.some((item) => item.nodeId === node.id && item.status === "open")).length}</strong><span>блокер</span></div>
      <button disabled={!coordination} onClick={() => coordination && select(coordination.id)}>Перейти до циклу</button>
    </section>
    <div className="dashboard-section-head"><div><span>Відхилення</span><h2>Блокери та відкриті рішення</h2></div><p>Адресат, строк реакції, рекомендація та наслідок без рішення.</p></div>
    <RiskRegisters payload={payload} userById={userById} openWork={openWork} />
    <div className="dashboard-section-head"><div><span>Аналітика</span><h2>Виконання, строки й навантаження</h2></div><p>Показники для управлінських рішень, а не підрахунку активності.</p></div>
    <section className="dashboard-filter-panel" aria-label="Фільтри аналітики"><div><span>Фільтри аналітики й контрольного реєстру</span><small>Не змінюють верхні стратегічні показники.</small></div><div className="page-filter-bar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Пошук завдання…" /><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="all">Усі відповідальні</option>{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><select value={healthFilter} onChange={(event) => openRegister(event.target.value as typeof healthFilter)}><option value="all">Усі стани</option><option value="blocked">Блокери</option><option value="risk">Ризик</option><option value="overdue">Прострочені</option><option value="decision">Потрібне рішення</option></select></div></section>
    <ReportAnalytics payload={payload} data={data} userById={userById} healthFilter={healthFilter} setHealthFilter={setHealthFilter} query={query} ownerId={ownerId} openWork={openWork} />
  </>;
}

type CalendarEvent = { id: string; date: string; nodeId: string; ownerId: string; type: "start" | "deadline" | "forecast" | "coordination" | "blocker" | "decision"; title: string; code: string };

function CalendarView({ payload, userById, openNode }: { payload: PortalPayload; userById: (id: string) => PortalUser | undefined; openNode: (id: string) => void }) {
  const today = new Date();
  const [month, setMonth] = useState(() => `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);
  const [ownerId, setOwnerId] = useState("all");
  const [type, setType] = useState<"all" | CalendarEvent["type"]>("all");
  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, "0")}`;
  const events: CalendarEvent[] = [];
  const add = (event: CalendarEvent) => { if (event.date >= monthStart && event.date <= monthEnd) events.push(event); };
  for (const node of payload.nodes.filter((item) => !item.archived)) {
    if (node.plannedStart) add({ id: `${node.id}-start`, date: node.plannedStart, nodeId: node.id, ownerId: node.assigneeId, type: "start", title: `Початок: ${node.title}`, code: node.code });
    if (node.plannedEnd) add({ id: `${node.id}-deadline`, date: node.plannedEnd, nodeId: node.id, ownerId: node.assigneeId, type: "deadline", title: `Строк: ${node.title}`, code: node.code });
    if (node.forecastEnd && node.forecastEnd !== node.plannedEnd) add({ id: `${node.id}-forecast`, date: node.forecastEnd, nodeId: node.id, ownerId: node.assigneeId, type: "forecast", title: `Прогноз: ${node.title}`, code: node.code });
    if (node.kind === "cycle" && node.coordinationStartDate && (node.coordinationIntervalDays || 0) > 0) {
      const interval = node.coordinationIntervalDays || 7;
      const occurrence = new Date(`${node.coordinationStartDate}T12:00:00`);
      const end = new Date(`${monthEnd}T12:00:00`);
      while (occurrence.toISOString().slice(0, 10) < monthStart) occurrence.setDate(occurrence.getDate() + interval);
      while (occurrence <= end) {
        const date = occurrence.toISOString().slice(0, 10);
        add({ id: `${node.id}-coordination-${date}`, date, nodeId: node.id, ownerId: node.assigneeId, type: "coordination", title: `Координація: ${node.title}`, code: node.code });
        occurrence.setDate(occurrence.getDate() + interval);
      }
    }
  }
  for (const blocker of payload.blockers.filter((item) => item.status === "open" && item.decisionDue)) {
    const node = payload.nodes.find((item) => item.id === blocker.nodeId); if (node) add({ id: `${blocker.id}-due`, date: blocker.decisionDue, nodeId: node.id, ownerId: blocker.ownerId, type: "blocker", title: `Реакція на блокер: ${blocker.title}`, code: node.code });
  }
  for (const decision of payload.decisions.filter((item) => item.status === "requested" && item.dueDate)) {
    const node = payload.nodes.find((item) => item.id === decision.nodeId); if (node) add({ id: `${decision.id}-due`, date: decision.dueDate, nodeId: node.id, ownerId: decision.decisionOwnerId, type: "decision", title: `Рішення: ${decision.question}`, code: node.code });
  }
  const visible = events.filter((event) => (ownerId === "all" || event.ownerId === ownerId) && (type === "all" || event.type === type)).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "uk"));
  const firstDay = new Date(year, monthNumber - 1, 1, 12);
  const leading = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const cells = Array.from({ length: Math.ceil((leading + daysInMonth) / 7) * 7 }, (_, index) => index - leading + 1);
  const changeMonth = (delta: number) => { const next = new Date(year, monthNumber - 1 + delta, 1, 12); setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`); };
  const eventLabel = (eventType: CalendarEvent["type"]) => eventType === "start" ? "Початок" : eventType === "deadline" ? "Строк" : eventType === "forecast" ? "Прогноз" : eventType === "coordination" ? "Координація" : eventType === "blocker" ? "Блокер" : "Рішення";
  return <><PageIntro kicker="Часовий контур" title="Календар строків і координацій" text="Планові дати, прогнози, управлінські рішення, реакція на блокери та повторювані координації циклів в одному місці." actions={<div className="calendar-period"><button onClick={() => changeMonth(-1)}>‹</button><button onClick={() => setMonth(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`)}>Сьогодні</button><strong>{new Intl.DateTimeFormat("uk-UA", { month: "long", year: "numeric" }).format(firstDay)}</strong><button onClick={() => changeMonth(1)}>›</button></div>} />
    <section className="panel calendar-panel"><div className="calendar-filters"><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="all">Усі відповідальні</option>{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="all">Усі події</option><option value="coordination">Координації</option><option value="deadline">Планові строки</option><option value="forecast">Прогнози</option><option value="start">Початки</option><option value="blocker">Блокери</option><option value="decision">Рішення</option></select><span>{visible.length} подій</span></div><div className="calendar-grid"><div className="calendar-weekdays">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-days">{cells.map((day, index) => { const date = day > 0 && day <= daysInMonth ? `${month}-${String(day).padStart(2, "0")}` : ""; const dayEvents = date ? visible.filter((event) => event.date === date) : []; return <div key={`${day}-${index}`} className={`${date ? "" : "outside"} ${date === today.toISOString().slice(0, 10) ? "today" : ""}`}><time>{date ? day : ""}</time>{dayEvents.slice(0, 4).map((event) => <button key={event.id} className={event.type} onClick={() => openNode(event.nodeId)} title={`${eventLabel(event.type)} · ${event.title}`}><span>{event.code}</span>{event.title}</button>)}{dayEvents.length > 4 && <small>+{dayEvents.length - 4} подій</small>}</div>; })}</div></div></section>
    <section className="panel calendar-agenda"><div className="panel-head"><div><span>Перелік місяця</span><h2>Усі строки за датою</h2></div><b className="count">{visible.length}</b></div><div>{visible.map((event) => <button key={event.id} onClick={() => openNode(event.nodeId)}><time>{dateLabel(event.date)}</time><span className={event.type}>{eventLabel(event.type)}</span><strong>{event.code} · {event.title}</strong><small>{userById(event.ownerId)?.name || "Не визначено"}</small></button>)}{!visible.length && <p className="empty-state padded">У цьому місяці подій за вибраними фільтрами немає.</p>}</div></section>
  </>;
}

function TreeView(props: {
  payload: PortalPayload; selected?: WorkNode; selectedId: string; setSelectedId: (id: string) => void; search: string; setSearch: (value: string) => void;
  userById: (id: string) => PortalUser | undefined; canManage: boolean; locks: EditingLock[]; openCreateKind: (kind: NodeKind, context?: WorkNode) => void; openEdit: (node: WorkNode) => Promise<void>;
  openWork: (node: WorkNode) => void; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; copyNodeLink: (node: WorkNode, targetView: View) => Promise<void>;
}) {
  const { payload, selected, selectedId, setSelectedId, search, setSearch, userById, canManage, locks, openCreateKind, openEdit, openWork, mutate, copyNodeLink } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(payload.nodes.filter((node) => node.kind !== "task").map((node) => node.id)));
  const [detailTab, setDetailTab] = useState<"passport" | "structure" | "history">("passport");
  const [treeCompact, setTreeCompact] = useState(false);
  const [treeWidth, setTreeWidth] = useState(() => {
    if (typeof window === "undefined") return 300;
    const saved = Number(window.localStorage.getItem("portal:tree-navigation-width"));
    return Number.isFinite(saved) && saved >= 220 && saved <= 560 ? saved : 300;
  });
  const [mobilePane, setMobilePane] = useState<"tree" | "card">("tree");
  const [kindFilter, setKindFilter] = useState<"all" | NodeKind>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState<"all" | "active" | "risk" | "completed">("all");
  const active = payload.nodes.filter((node) => !node.archived);
  const query = search.trim().toLowerCase();
  const matchesFilters = (node: WorkNode) => {
    const matchesQuery = !query || `${node.code} ${node.title} ${node.result}`.toLowerCase().includes(query);
    const matchesKind = kindFilter === "all" || node.kind === kindFilter;
    const matchesOwner = ownerFilter === "all" || node.ownerId === ownerFilter || node.assigneeId === ownerFilter;
    const matchesState = stateFilter === "all" || stateFilter === "active" && !["completed", "cancelled"].includes(node.lifecycle) || stateFilter === "risk" && node.health !== "normal" || stateFilter === "completed" && node.lifecycle === "completed";
    return matchesQuery && matchesKind && matchesOwner && matchesState;
  };
  const directMatches = active.filter(matchesFilters);
  const flatLevelResults = kindFilter !== "all";
  const visibleIds = new Set<string>();
  for (const node of directMatches) {
    if (!flatLevelResults) {
      visibleIds.add(node.id);
      let parentId = node.parentId;
      while (parentId) {
        visibleIds.add(parentId);
        parentId = payload.nodes.find((item) => item.id === parentId)?.parentId || null;
      }
    }
  }
  const filtered = flatLevelResults ? directMatches : active.filter((node) => visibleIds.has(node.id));
  const predecessors = selected ? payload.dependencies.filter((item) => item.successorId === selected.id).map((item) => payload.nodes.find((node) => node.id === item.predecessorId)).filter(Boolean) as WorkNode[] : [];
  const children = selected ? payload.nodes.filter((node) => node.parentId === selected.id && !node.archived) : [];
  const startTreeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (treeCompact || window.innerWidth <= 900) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = treeWidth;
    let latestWidth = treeWidth;
    const move = (pointerEvent: PointerEvent) => {
      latestWidth = Math.max(220, Math.min(Math.min(560, window.innerWidth * .52), startWidth + pointerEvent.clientX - startX));
      setTreeWidth(Math.round(latestWidth));
    };
    const stop = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.localStorage.setItem("portal:tree-navigation-width", String(Math.round(latestWidth)));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const archiveBranch = async (node: WorkNode) => {
    if (!window.confirm(`Видалити ${node.code} з робочого дерева? Запис залишиться в журналі та архіві.`)) return;
    const branchIds = new Set(descendants(payload.nodes, node.id).map((item) => item.id));
    const ok = await mutate(`Видалено з дерева ${node.code}`, node.id, (state) => {
      state.nodes.forEach((item) => { if (branchIds.has(item.id)) item.archived = true; });
    });
    if (ok) setSelectedId(node.parentId || active.find((item) => !branchIds.has(item.id))?.id || "");
  };

  const renderBranch = (parentId: string | null, depth = 0): React.ReactNode => filtered.filter((node) => node.parentId === parentId).map((node) => {
    const hasChildren = active.some((child) => child.parentId === node.id);
    const mayEdit = canManage || node.ownerId === payload.currentUser.id;
    const lock = locks.find((item) => item.entityId === node.id && item.userId !== payload.currentUser.id);
    return <div key={node.id} className="tree-branch">
      <div className={`tree-row ${node.id === selectedId ? "selected" : ""} kind-${node.kind}`} style={{ paddingLeft: 3 + depth * 7 }}>
        <button className="tree-toggle" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })} aria-label={expanded.has(node.id) ? "Згорнути" : "Розгорнути"}>{hasChildren ? (expanded.has(node.id) ? "⌄" : "›") : "·"}</button>
        <button className="tree-row-main" onClick={() => { setSelectedId(node.id); setDetailTab("passport"); setMobilePane("card"); }}><span className="tree-code">{node.code}</span><span className="tree-name">{node.title}</span>{lock && <span className="editing-badge" title={`${lock.userName} редагує картку`}>✎ {lock.userName}</span>}<StatusBadge node={node} /></button>
        {mayEdit && <details className="tree-row-menu"><summary title={`Дії з ${kindLabels[node.kind].toLowerCase()}`} aria-label={`Дії з ${node.code}`}>⋮</summary><div><button disabled={Boolean(lock)} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void openEdit(node); }}><span>✎</span>{lock ? `Редагує ${lock.userName}` : "Редагувати"}</button>{node.kind === "goal" && <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreateKind("cycle", node); }}><span>＋</span>Додати цикл</button>}{node.kind === "cycle" && <><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreateKind("subcycle", node); }}><span>＋</span>Додати підцикл</button><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreateKind("task", node); }}><span>✓</span>Додати завдання</button></>}{node.kind === "subcycle" && <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreateKind("task", node); }}><span>✓</span>Додати завдання</button>}<button className="delete" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void archiveBranch(node); }}><span>×</span>Видалити з дерева</button></div></details>}
      </div>
      {hasChildren && expanded.has(node.id) && renderBranch(node.id, depth + 1)}
    </div>;
  });
  const openTreeCard = (nodeId: string) => { setSelectedId(nodeId); setDetailTab("passport"); setMobilePane("card"); };
  const renderFlatResult = (node: WorkNode) => {
    const path = nodePath(payload.nodes, node).slice(0, -1);
    const lock = locks.find((item) => item.entityId === node.id && item.userId !== payload.currentUser.id);
    return <div className="tree-filter-result" key={node.id}>
      <nav className="tree-filter-path" aria-label={`Шлях до ${node.code}`}>{path.length ? path.map((ancestor, index) => <span key={ancestor.id}><button title={`${kindLabels[ancestor.kind]} · ${ancestor.code} · ${ancestor.title}`} onClick={() => openTreeCard(ancestor.id)}>{ancestor.code}</button>{index < path.length - 1 && <i>/</i>}</span>) : <small>Верхній рівень</small>}</nav>
      <div className={`tree-row tree-flat-row ${node.id === selectedId ? "selected" : ""} kind-${node.kind}`}><span className="tree-flat-marker">·</span><button className="tree-row-main" onClick={() => openTreeCard(node.id)} title={`${kindLabels[node.kind]} · ${node.code} · ${node.title}`}><span className="tree-code">{node.code}</span><span className="tree-name">{node.title}</span>{lock && <span className="editing-badge" title={`${lock.userName} редагує картку`}>✎ {lock.userName}</span>}<StatusBadge node={node} /></button></div>
    </div>;
  };

  return <>
    <PageIntro kicker="Структура управління" title="Дерево цілей, циклів і завдань" text="Тут створюється структура та зберігаються паспорти. Виконання й звіти ведуться у «Моїй роботі»." actions={canManage && <details className="create-uo-menu"><summary>+ Створити</summary><div>{(["goal", "cycle", "subcycle", "task"] as NodeKind[]).map((kind) => <button key={kind} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreateKind(kind, selected); }}><span>{kind === "goal" ? "S" : kind === "cycle" ? "P" : kind === "subcycle" ? "P.x" : "✓"}</span>{kindLabels[kind]}</button>)}</div></details>} />
    <div className="mobile-tree-switch" role="tablist"><button role="tab" aria-selected={mobilePane === "tree"} className={mobilePane === "tree" ? "active" : ""} onClick={() => setMobilePane("tree")}>Дерево</button><button role="tab" aria-selected={mobilePane === "card"} disabled={!selected} className={mobilePane === "card" ? "active" : ""} onClick={() => setMobilePane("card")}>{selected ? `Картка ${selected.code}` : "Картка"}</button></div>
    <div className={`tree-workbench ${treeCompact ? "compact-tree" : ""} mobile-pane-${mobilePane}`} style={{ "--tree-nav-width": `${treeWidth}px` } as React.CSSProperties}>
      <aside className="tree-catalog">
        <div className="catalog-head">{!treeCompact && <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Пошук у дереві…" />}<span>{filtered.length}</span><button className="tree-compact-toggle" onClick={() => setTreeCompact((value) => !value)} title={treeCompact ? "Розгорнути дерево" : "Згорнути дерево до кодів"} aria-label={treeCompact ? "Розгорнути дерево" : "Згорнути дерево до кодів"}>{treeCompact ? "→" : "К"}</button></div>
        {!treeCompact && <div className="compact-filters"><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as "all" | NodeKind)}><option value="all">Усі рівні</option><option value="goal">Цілі</option><option value="cycle">Цикли</option><option value="subcycle">Підцикли</option><option value="task">Завдання</option></select><select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option value="all">Усі відповідальні</option>{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">Усі стани</option><option value="active">Активні</option><option value="risk">Ризик / блокер</option><option value="completed">Завершені</option></select></div>}
        <div className={`tree-scroll ${flatLevelResults ? "flat-filter-results" : ""}`}>{flatLevelResults ? filtered.map(renderFlatResult) : renderBranch(null)}{!filtered.length && <p className="empty-state padded">{flatLevelResults ? "За вибраними фільтрами об’єктів цього рівня немає." : "Дерево порожнє. Створіть першу стратегічну ціль."}</p>}</div>
        {!treeCompact && <button type="button" className="tree-width-handle" aria-label={`Змінити ширину навігації дерева, зараз ${treeWidth} пікселів`} title="Перетягніть для зміни ширини · стрілки — крок 20 пікселів · подвійне натискання — стандартна ширина" onPointerDown={startTreeResize} onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const next = Math.max(220, Math.min(560, treeWidth + (event.key === "ArrowRight" ? 20 : -20))); setTreeWidth(next); window.localStorage.setItem("portal:tree-navigation-width", String(next)); }} onDoubleClick={() => { setTreeWidth(300); window.localStorage.setItem("portal:tree-navigation-width", "300"); }} />}
      </aside>
      {selected ? <section className="node-detail">
        <header className="node-detail-head">
          <div><span>{kindLabels[selected.kind]} · {selected.code}</span><h2>{selected.title}</h2><p>{selected.result}</p></div>
          <div className="node-head-actions"><ProgressRing value={selected.progress} /><button className="secondary" onClick={() => void copyNodeLink(selected, "tree")}>Копіювати посилання</button><button className="primary work-link" onClick={() => openWork(selected)}>Відкрити робочу картку →</button></div>
        </header>
        <div className="status-line"><StatusBadge node={selected} />{selected.decisionRequired && <span className="decision-badge">Потрібне рішення</span>}<span>{lifecycleLabels[selected.lifecycle]}</span><span>Оновлено {new Date(selected.updatedAt).toLocaleString("uk-UA")}</span></div>
        <div className="detail-tabs" role="tablist">{(["passport", "structure", "history"] as const).map((tab) => <button key={tab} role="tab" aria-selected={detailTab === tab} className={`${detailTab === tab ? "active" : ""} ${tab === "history" ? "history-tab" : ""}`} onClick={() => setDetailTab(tab)}>{tab === "passport" ? "Паспорт" : tab === "structure" ? "Структура і зв’язки" : `Історія · ${payload.audit.filter((entry) => entry.entityId === selected.id).length + (selected.updates || []).length}`}</button>)}</div>
        {detailTab === "passport" && <TreeWorkSnapshot node={selected} payload={payload} userById={userById} />}
        {detailTab === "passport" && <><div className="detail-grid"><article><span>Координатор</span><div className="person-line"><UserAvatar user={userById(selected.ownerId)} /><div><strong>{userById(selected.ownerId)?.name}</strong><small>Координує отримання результату</small></div></div></article><article><span>Виконавець</span><div className="person-line"><UserAvatar user={userById(selected.assigneeId)} /><div><strong>{userById(selected.assigneeId)?.name}</strong><small>{selected.kind === "task" ? "Виконує завдання" : "Координує нижчі рівні"}</small></div></div></article><article><span>Керівник вищої ланки</span><div className="person-line"><UserAvatar user={userById(selected.acceptorId)} /><div><strong>{userById(selected.acceptorId)?.name}</strong><small>Контролює та приймає результат</small></div></div></article><article><span>Плановий строк</span><strong>{dateLabel(selected.plannedEnd)}</strong><small>{daysUntil(selected.plannedEnd) !== null ? `${daysUntil(selected.plannedEnd)} дн. до строку` : "Дата не встановлена"}</small></article><article><span>Фактичний стан</span><strong>{lifecycleLabels[selected.lifecycle]} · {selected.progress}%</strong><small>{selected.kind === "task" ? "Оновлюється у робочій картці" : "Розраховано з нижчих рівнів"}</small></article></div><div className="detail-columns info-only"><div><section className="detail-section"><h3>Результат і межі</h3><dl><dt>Опис</dt><dd>{selected.description || "Не визначено"}</dd><dt>Готовий результат</dt><dd>{selected.result || "Не визначено"}</dd><dt>Що не є результатом</dt><dd>{selected.nonResult || "Не визначено"}</dd><dt>Критерій приймання</dt><dd>{selected.acceptanceCriteria || "Не визначено"}</dd></dl></section><section className="detail-section"><h3>Умови виконання</h3><dl><dt>Спосіб початку</dt><dd>{startLabels[selected.startMode]}</dd><dt>Повноваження</dt><dd>{selected.authority || "Не визначено"}</dd><dt>Ресурс</dt><dd>{selected.resource || "Не визначено"}</dd><dt>Контрольне місце</dt><dd>{selected.controlPlace || "Не визначено"}</dd></dl></section></div><aside><section className="side-section explainer"><b>Режим перегляду</b><h3>Дерево не є робочим журналом</h3><p>Тут перевіряють місце в структурі, межі, відповідального та агрегований стан. Виконання, звіт і Asana відкриваються в робочій картці.</p><button className="primary" onClick={() => openWork(selected)}>Перейти до роботи</button></section><section className="side-section"><div className="side-head"><h3>Докази результату</h3><span>{selected.evidence.length}</span></div>{selected.evidence.map((item) => <a className="evidence-row" key={item.id} href={item.kind === "note" ? undefined : item.value} target="_blank" rel="noreferrer"><span>{item.kind === "file" ? "Файл" : item.kind === "link" ? "Посилання" : "Нотатка"}</span><strong>{item.label}</strong></a>)}{!selected.evidence.length && <p className="empty-state">Докази ще не додано.</p>}</section></aside></div></>}
        {detailTab === "structure" && <div className="detail-tab-body"><section className="detail-section"><h3>Батьківський рівень</h3>{selected.parentId ? <button className="parent-link" onClick={() => setSelectedId(selected.parentId!)}>{payload.nodes.find((node) => node.id === selected.parentId)?.code} · {payload.nodes.find((node) => node.id === selected.parentId)?.title}</button> : <p className="empty-state">Верхній рівень дерева.</p>}</section><section className="detail-section"><h3>Нижчий рівень</h3>{children.length > 0 ? <div className="child-list">{children.map((node) => <button key={node.id} onClick={() => setSelectedId(node.id)}><span>{node.code}</span><strong>{node.title}</strong><StatusBadge node={node} /></button>)}</div> : <p className="empty-state">Нижчих рівнів немає.</p>}</section><section className="detail-section"><h3>Залежності виконання</h3>{predecessors.length ? predecessors.map((node) => <button className="parent-link" key={node.id} onClick={() => setSelectedId(node.id)}>Після {node.code} · {node.title}</button>) : <p className="empty-state">Окремих попередників немає.</p>}</section></div>}
        {detailTab === "history" && <div className="detail-tab-body"><section className="detail-section"><h3>Робочі звіти</h3><div className="update-history">{(selected.updates || []).map((item) => <article key={item.id}><time>{new Date(item.createdAt).toLocaleString("uk-UA")}</time><strong>{lifecycleLabels[item.lifecycle]} · {item.progress}%</strong><p>{item.summary}</p><small>Наступна дія: {item.nextAction || "Не вказано"}</small></article>)}{!(selected.updates || []).length && <p className="empty-state">Робочих звітів ще немає.</p>}</div></section><section className="detail-section"><h3>Журнал змін</h3><div className="update-history">{payload.audit.filter((entry) => entry.entityId === selected.id).map((entry) => <article key={entry.id}><time>{new Date(entry.at).toLocaleString("uk-UA")}</time><strong>{entry.action}</strong><small>{entry.by}</small></article>)}</div></section></div>}
      </section> : <section className="node-detail empty-tree"><div><span>Початок роботи</span><h2>Створіть першу стратегічну ціль</h2><p>Після цього до неї можна буде послідовно додати управлінські цикли, підцикли та конкретні завдання.</p>{canManage && <button className="primary" onClick={() => openCreateKind("goal")}>+ Створити стратегічну ціль</button>}</div></section>}
    </div>
  </>;
}

function TreeWorkSnapshot({ node, payload, userById }: { node: WorkNode; payload: PortalPayload; userById: (id: string) => PortalUser | undefined }) {
  const reports = [...(node.updates || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestReport = reports[0];
  const blockers = payload.blockers.filter((item) => item.nodeId === node.id && item.status === "open");
  const decisions = payload.decisions.filter((item) => item.nodeId === node.id && item.status === "requested");
  const acceptance = [...payload.acceptances].filter((item) => item.nodeId === node.id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  const messages = [...(payload.discussions || [])].filter((item) => item.nodeId === node.id && !item.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const acceptanceLabel = !acceptance ? "Не передавалося" : acceptance.status === "submitted" ? "Очікує приймання" : acceptance.status === "accepted" ? "Прийнято" : "Повернуто на доопрацювання";
  return <section className="tree-work-snapshot" aria-label={`Стан робочої картки ${node.code}`}><header><div><span>Робоча картка · лише перегляд</span><h3>Стан, звіти та взаємодія</h3><p>У дереві показано актуальну робочу інформацію. Внесення змін виконується після переходу до «Моєї роботи».</p></div><StatusBadge node={node} /></header><div className="tree-snapshot-summary"><article><h4>Фактичний стан</h4><dl><dt>Статус</dt><dd>{lifecycleLabels[node.lifecycle]}</dd><dt>Стан виконання</dt><dd>{healthLabels[node.health]}</dd><dt>Прогрес</dt><dd>{node.progress}%</dd><dt>Прогноз завершення</dt><dd>{dateLabel(node.forecastEnd)}</dd><dt>Фактичний початок</dt><dd>{dateLabel(node.actualStart)}</dd><dt>Фактичне завершення</dt><dd>{dateLabel(node.actualEnd)}</dd></dl></article><article><h4>Останній робочий звіт</h4>{latestReport ? <><time>{new Date(latestReport.createdAt).toLocaleString("uk-UA")} · {userById(latestReport.createdBy)?.name || (latestReport.source === "asana" ? "Asana" : "Учасник")}</time><strong>{latestReport.summary}</strong><p>Наступна дія: {latestReport.nextAction || "Не визначено"}</p><small>{lifecycleLabels[latestReport.lifecycle]} · {latestReport.progress}% · прогноз {dateLabel(latestReport.forecastEnd)}</small></> : <p className="empty-state">Робочих звітів ще немає.</p>}</article><article><h4>Приймання результату</h4><strong>{acceptanceLabel}</strong>{acceptance && <dl><dt>Керівник</dt><dd>{userById(acceptance.acceptorId)?.name || "Не визначено"}</dd><dt>Спроба</dt><dd>{acceptance.attempt}</dd><dt>Передано</dt><dd>{new Date(acceptance.submittedAt).toLocaleString("uk-UA")}</dd><dt>Коментар</dt><dd>{acceptance.feedback || acceptance.evidenceNote || "Не додано"}</dd></dl>}</article><article><h4>Asana</h4>{node.asana.taskGid ? <><strong>{node.asana.remoteName || `Задача ${node.asana.taskGid}`}</strong><dl><dt>Стан в Asana</dt><dd>{node.asana.remoteCompleted ? "Завершено" : "Активне"}</dd><dt>Строк</dt><dd>{dateLabel(node.asana.remoteDueOn || "")}</dd><dt>Виконавець</dt><dd>{node.asana.remoteAssignee || "Не визначено"}</dd><dt>Синхронізація</dt><dd>{node.asana.lastSyncedAt ? new Date(node.asana.lastSyncedAt).toLocaleString("uk-UA") : "Ще не виконувалась"}</dd></dl>{node.asana.taskUrl && <a href={node.asana.taskUrl} target="_blank" rel="noreferrer">Відкрити задачу Asana ↗</a>}</> : <p className="empty-state">Задачу Asana не прив’язано.</p>}</article></div><div className="tree-snapshot-streams"><section><div className="snapshot-section-head"><h4>Відкриті блокери</h4><b>{blockers.length}</b></div>{blockers.map((item) => <article className="snapshot-alert" key={item.id}><strong>{item.title}</strong><p>{item.facts}</p><small>{item.approvalStatus === "approved" ? "Статус блокера погоджено" : "Очікує погодження"} · відповідальний {userById(item.ownerId)?.name || "не визначений"}</small></article>)}{!blockers.length && <p className="empty-state">Відкритих блокерів немає.</p>}</section><section><div className="snapshot-section-head"><h4>Відкриті рішення</h4><b>{decisions.length}</b></div>{decisions.map((item) => <article className="snapshot-decision" key={item.id}><strong>{item.question}</strong><p>Варіанти: {item.options || "Не зазначені"}</p><p>Рекомендація: {item.recommendation || "Не зазначена"}</p><small>Вирішує {userById(item.decisionOwnerId)?.name || "не визначено"} · до {dateLabel(item.dueDate)}</small></article>)}{!decisions.length && <p className="empty-state">Відкритих рішень немає.</p>}</section><section><div className="snapshot-section-head"><h4>Останні повідомлення</h4><b>{messages.length}</b></div>{messages.map((item) => <article className="snapshot-message" key={item.id}><div><strong>{userById(item.authorId)?.name || "Система"}</strong><time>{new Date(item.createdAt).toLocaleString("uk-UA")}</time></div><p>{item.text}</p><small>{item.kind === "question" ? item.resolvedAt ? "Питання закрито" : "Очікує відповіді" : item.kind === "approval" ? "Погодження" : item.kind === "decision" ? "Рішення" : "Коментар"}</small></article>)}{!messages.length && <p className="empty-state">Повідомлень у картці немає.</p>}</section><section><div className="snapshot-section-head"><h4>Останні три звіти</h4><b>{Math.min(3, reports.length)}</b></div>{reports.slice(0, 3).map((item) => <article className="snapshot-report" key={item.id}><div><strong>{lifecycleLabels[item.lifecycle]} · {item.progress}%</strong><time>{new Date(item.createdAt).toLocaleString("uk-UA")}</time></div><p>{item.summary}</p><small>{item.nextAction ? `Далі: ${item.nextAction}` : "Наступну дію не вказано"}</small></article>)}{!reports.length && <p className="empty-state">Звітів ще немає.</p>}</section></div></section>;
}

function NotificationsView({ payload, userById, mutate, openNode }: { payload: PortalPayload; userById: (id: string) => PortalUser | undefined; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; openNode: (id: string, filter: WorkFilter, focus: WorkFocus) => void }) {
  const [filter, setFilter] = useState<"all" | "unread" | PortalNotification["type"]>("unread");
  const mine = (payload.notifications || []).filter((item) => item.userId === payload.currentUser.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visible = mine.filter((item) => filter === "all" || (filter === "unread" ? !item.readAt : item.type === filter));
  const pendingApprovals = payload.acceptances.filter((item) => item.status === "submitted" && item.acceptorId === payload.currentUser.id);
  const pendingDecisions = payload.decisions.filter((item) => item.status === "requested" && item.decisionOwnerId === payload.currentUser.id);
  const pendingBlockers = payload.blockers.filter((item) => item.status === "open" && (!item.approvalStatus || item.approvalStatus === "pending") && item.escalationToId === payload.currentUser.id);
  const pendingQuestions = (payload.discussions || []).filter((item) => !item.deletedAt && (item.kind === "question" || item.requiresResponse) && !item.resolvedAt && item.recipientId === payload.currentUser.id);
  const markRead = (notification: PortalNotification) => notification.readAt ? Promise.resolve(true) : mutate("Сповіщення прочитано", notification.id, (state) => { const item = state.notifications.find((candidate) => candidate.id === notification.id); if (item) item.readAt = isoNow(); });
  const markAllRead = () => mutate("Сповіщення прочитано всі", payload.currentUser.id, (state) => { for (const item of state.notifications) if (item.userId === payload.currentUser.id && !item.readAt) item.readAt = isoNow(); });
  const routeFor = (nodeId: string): WorkFilter => { const node = payload.nodes.find((item) => item.id === nodeId); return node?.acceptorId === payload.currentUser.id ? "acceptance" : node?.ownerId === payload.currentUser.id ? "manage" : node?.assigneeId === payload.currentUser.id ? "action" : "all"; };
  const open = async (notification: PortalNotification) => {
    await markRead(notification);
    if (!notification.nodeId || !payload.nodes.some((node) => node.id === notification.nodeId && !node.archived)) return;
    const isAcceptor = payload.nodes.find((node) => node.id === notification.nodeId)?.acceptorId === payload.currentUser.id;
    const focus = notification.type === "blocker" ? "blocker" : notification.type === "decision" ? "decision" : notification.type === "acceptance" ? isAcceptor ? "acceptance" : "discussion" : ["question", "comment"].includes(notification.type) ? "discussion" : null;
    const targetFilter = notification.type === "acceptance" && isAcceptor ? "acceptance" : routeFor(notification.nodeId);
    openNode(notification.nodeId, targetFilter, focus);
  };
  const typeLabel = (type: PortalNotification["type"]) => type === "delegation" ? "Делегування" : type === "blocker" ? "Блокер" : type === "question" ? "Питання" : type === "decision" ? "Рішення" : type === "acceptance" ? "Погодження" : type === "comment" ? "Коментар" : type === "created" ? "Створення" : type === "completed" ? "Завершення" : "Оновлення";
  return <><PageIntro kicker="Персональний центр" title="Вхідні та сповіщення" text="Усі дії, адресовані вам, і зміни в картках, за які ви відповідаєте або в яких берете участь." actions={<button className="secondary" disabled={!mine.some((item) => !item.readAt)} onClick={() => void markAllRead()}>Позначити все прочитаним</button>} />
    <section className="panel inbox-actions"><div className="panel-head"><div><span>Потребують дії</span><h2>Блокери, рішення, питання та приймання</h2></div><b className="count amber">{pendingBlockers.length + pendingApprovals.length + pendingDecisions.length + pendingQuestions.length}</b></div><div>{pendingBlockers.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <button key={item.id} onClick={() => openNode(item.nodeId, routeFor(item.nodeId), "blocker")}><span>Блокер · {node?.code}</span><strong>{item.title}</strong><small>Реакція до {dateLabel(item.decisionDue)}</small></button>; })}{pendingApprovals.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <button key={item.id} onClick={() => openNode(item.nodeId, "acceptance", "acceptance")}><span>Приймання · {node?.code}</span><strong>{node?.title}</strong><small>Передано {new Date(item.submittedAt).toLocaleString("uk-UA")}</small></button>; })}{pendingDecisions.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <button key={item.id} onClick={() => openNode(item.nodeId, routeFor(item.nodeId), "decision")}><span>Рішення · {node?.code}</span><strong>{item.question}</strong><small>До {dateLabel(item.dueDate)}</small></button>; })}{pendingQuestions.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <button key={item.id} onClick={() => openNode(item.nodeId, routeFor(item.nodeId), "discussion")}><span>{item.kind === "question" ? "Питання" : "Коментар"} · {node?.code}</span><strong>{item.text}</strong><small>{userById(item.authorId)?.name || "Учасник"}</small></button>; })}{!pendingBlockers.length && !pendingApprovals.length && !pendingDecisions.length && !pendingQuestions.length && <p className="empty-state padded">Звернень, які потребують вашої дії, немає.</p>}</div></section>
    <section className="panel notification-center"><div className="notification-toolbar"><div>{(["unread", "all", "delegation", "blocker", "question", "decision", "acceptance", "comment", "updated"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "unread" ? "Непрочитані" : item === "all" ? "Усі" : typeLabel(item)}</button>)}</div><span>{visible.length} записів</span></div><div className="notification-list">{visible.map((item) => <article key={item.id} className={item.readAt ? "read" : "unread"}><button onClick={() => void open(item)}><i aria-hidden="true" /><div><span>{typeLabel(item.type)}{item.nodeId && payload.nodes.find((node) => node.id === item.nodeId)?.code ? ` · ${payload.nodes.find((node) => node.id === item.nodeId)?.code}` : ""}</span><strong>{item.title}</strong><p>{item.detail}</p><small>{userById(item.actorId)?.name || "Система"} · {new Date(item.createdAt).toLocaleString("uk-UA")}</small></div></button>{!item.readAt && <button className="mark-read" onClick={() => void markRead(item)}>Прочитано</button>}</article>)}{!visible.length && <p className="empty-state padded">За вибраним фільтром сповіщень немає.</p>}</div></section>
  </>;
}

function MyWork({ payload, selected, selectedId, setSelectedId, initialFilter, focusTarget, userById, canManage, saveWorkUpdate, resolveAcceptance, completeNode, openEdit, copyNodeLink, setModal, asanaStatus, mutate, setNotice, openTree }: { payload: PortalPayload; selected?: WorkNode; selectedId: string; setSelectedId: (id: string) => void; initialFilter: WorkFilter; focusTarget: WorkFocus; userById: (id: string) => PortalUser | undefined; canManage: boolean; saveWorkUpdate: (node: WorkNode, update: Omit<WorkUpdate, "id" | "createdAt" | "createdBy" | "source">) => Promise<boolean>; resolveAcceptance: (acceptance: Acceptance, accepted: boolean, feedback?: string) => Promise<boolean>; completeNode: (node: WorkNode) => Promise<boolean>; openEdit: (node: WorkNode) => Promise<void>; copyNodeLink: (node: WorkNode, targetView: View) => Promise<void>; setModal: (modal: Modal) => void; asanaStatus: { configured: boolean; connected: boolean; connection?: Record<string, string> } | null; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; setNotice: Notify; openTree: (id: string) => void }) {
  const [filter, setFilter] = useState<WorkFilter>(initialFilter);
  const [listQuery, setListQuery] = useState("");
  const [sort, setSort] = useState<"deadline" | "priority" | "updated" | "progress">("deadline");
  const [levelFilter, setLevelFilter] = useState<"all" | NodeKind>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<"all" | LifecycleStatus>("all");
  const [workHealthFilter, setWorkHealthFilter] = useState<"all" | HealthStatus | "branch_blocker">("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | WorkNode["priority"]>("all");
  const pendingApprovals = payload.acceptances.filter((item) => item.status === "submitted" && item.acceptorId === payload.currentUser.id);
  const pendingDecisions = payload.decisions.filter((item) => item.status === "requested" && item.decisionOwnerId === payload.currentUser.id);
  const pendingBlockers = payload.blockers.filter((item) => item.status === "open" && (!item.approvalStatus || item.approvalStatus === "pending") && item.escalationToId === payload.currentUser.id);
  const pendingQuestions = (payload.discussions || []).filter((item) => !item.deletedAt && (item.kind === "question" || item.requiresResponse) && !item.resolvedAt && item.recipientId === payload.currentUser.id);
  const incomingNodeIds = new Set([...pendingBlockers.map((item) => item.nodeId), ...pendingApprovals.map((item) => item.nodeId), ...pendingDecisions.map((item) => item.nodeId), ...pendingQuestions.map((item) => item.nodeId)]);
  const mine = payload.nodes.filter((node) => !node.archived && (node.ownerId === payload.currentUser.id || node.assigneeId === payload.currentUser.id || node.acceptorId === payload.currentUser.id || node.participantIds.includes(payload.currentUser.id) || incomingNodeIds.has(node.id)));
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  const filtered = mine.filter((node) => filter === "all" || filter === "action" && node.assigneeId === payload.currentUser.id && !["completed", "cancelled"].includes(node.lifecycle) || filter === "manage" && node.ownerId === payload.currentUser.id || filter === "acceptance" && node.acceptorId === payload.currentUser.id)
    .filter((node) => !listQuery.trim() || `${node.code} ${node.title} ${node.result}`.toLowerCase().includes(listQuery.trim().toLowerCase()))
    .filter((node) => levelFilter === "all" || node.kind === levelFilter)
    .filter((node) => lifecycleFilter === "all" || node.lifecycle === lifecycleFilter)
    .filter((node) => workHealthFilter === "all" || (workHealthFilter === "branch_blocker" ? branchHasOpenBlocker(payload, node) : node.health === workHealthFilter))
    .filter((node) => priorityFilter === "all" || node.priority === priorityFilter)
    .sort((a, b) => sort === "deadline" ? (a.plannedEnd || "9999").localeCompare(b.plannedEnd || "9999") : sort === "priority" ? priorityOrder[a.priority] - priorityOrder[b.priority] : sort === "progress" ? a.progress - b.progress : b.updatedAt.localeCompare(a.updatedAt));
  const selectedNode = payload.nodes.find((node) => node.id === selectedId && !node.archived) || selected;
  const current = selectedNode && filtered.some((node) => node.id === selectedNode.id) ? selectedNode : filtered[0];
  useEffect(() => {
    if (!current || !focusTarget) return;
    window.requestAnimationFrame(() => document.getElementById(focusTarget === "discussion" ? `discussion-${current.id}` : `manager-actions-${current.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [current, focusTarget]);
  const latestAcceptance = current ? payload.acceptances.find((item) => item.nodeId === current.id && item.status === "submitted") : undefined;
  const openDecisions = current ? payload.decisions.filter((item) => item.nodeId === current.id && item.status === "requested").sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const decidedDecisions = current ? payload.decisions.filter((item) => item.nodeId === current.id && item.status === "decided").sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const children = current ? payload.nodes.filter((node) => node.parentId === current.id && !node.archived) : [];
  const mayWork = current && (canManage || current.ownerId === payload.currentUser.id || current.assigneeId === payload.currentUser.id);
  const mayEditCard = current && (canManage || current.ownerId === payload.currentUser.id);
  const completionReason = current ? completionBlockReason(payload.nodes, current) : "";
  const scrollToSection = (id: string) => {
    const fallback = id.startsWith("work-status-") ? ".status-update" : id.startsWith("work-history-") ? ".update-panel" : id.startsWith("card-description-") ? ".work-card-description" : "";
    (document.getElementById(id) || (fallback ? document.querySelector(fallback) : null))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const activeFilterCount = [levelFilter, lifecycleFilter, workHealthFilter, priorityFilter].filter((value) => value !== "all").length;
  const resetListFilters = () => { setLevelFilter("all"); setLifecycleFilter("all"); setWorkHealthFilter("all"); setPriorityFilter("all"); };
  const resolveDecision = (decision: Decision, resolution: string) => mutate(`Прийнято рішення для ${current?.code || decision.nodeId}`, decision.nodeId, (state) => {
    const item = state.decisions.find((candidate) => candidate.id === decision.id)!;
    item.status = "decided";
    item.resolution = resolution.trim();
    item.decidedAt = isoNow();
    const node = state.nodes.find((candidate) => candidate.id === decision.nodeId)!;
    node.decisionRequired = state.decisions.some((candidate) => candidate.nodeId === node.id && candidate.id !== decision.id && candidate.status === "requested");
    const requestMessage = state.discussions.find((message) => message.relatedType === "decision" && message.relatedId === decision.id);
    if (requestMessage) { requestMessage.resolvedAt = isoNow(); requestMessage.resolvedBy = payload.currentUser.id; }
    state.discussions.unshift({ id: crypto.randomUUID(), nodeId: decision.nodeId, authorId: payload.currentUser.id, recipientId: requestMessage?.authorId, relatedType: "decision", relatedId: decision.id, text: `Рішення прийнято: ${resolution.trim()}`, kind: "decision", createdAt: isoNow() });
  });

  return <>
    <div className="my-workbench">
      <aside className="work-inbox">
        <div className="work-filter">{(["action", "manage", "acceptance", "all"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "action" ? "Мої дії" : item === "manage" ? "Координую" : item === "acceptance" ? "Приймаю" : "Усі"}</button>)}</div>
        <div className="work-list-controls"><input value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder="Пошук…" /><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="deadline">За строком</option><option value="priority">За пріоритетом</option><option value="updated">За оновленням</option><option value="progress">За прогресом</option></select></div>
        <details className="work-advanced-filters"><summary><span>Рівень, статус і стан</span>{activeFilterCount > 0 && <b>{activeFilterCount}</b>}<i>⌄</i></summary><div><label><span>Рівень</span><select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as typeof levelFilter)}><option value="all">Усі рівні</option><option value="goal">Цілі</option><option value="cycle">Цикли</option><option value="subcycle">Підцикли</option><option value="task">Завдання</option></select></label><label><span>Статус</span><select value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value as typeof lifecycleFilter)}><option value="all">Усі статуси</option>{Object.entries(lifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Стан</span><select value={workHealthFilter} onChange={(event) => setWorkHealthFilter(event.target.value as typeof workHealthFilter)}><option value="all">Будь-який стан</option><option value="branch_blocker">Блокери</option><option value="normal">Нормально</option><option value="risk">Є ризик</option><option value="blocked">Заблоковано</option></select></label><label><span>Пріоритет</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}><option value="all">Усі пріоритети</option><option value="critical">Критичний</option><option value="high">Високий</option><option value="normal">Нормальний</option><option value="low">Низький</option></select></label><button type="button" disabled={!activeFilterCount} onClick={resetListFilters}>Скинути фільтри</button></div></details>
        <div className="work-inbox-list">{filtered.map((node) => <button className={`work-list-row ${node.id === current?.id ? "selected" : ""}`} key={node.id} onClick={() => setSelectedId(node.id)}><div><span>{kindLabels[node.kind]} · {node.code}</span><strong>{node.title}</strong></div><StatusBadge node={node} /><footer><small>{node.progress}%</small><time>{dateLabel(node.plannedEnd)}</time></footer></button>)}{!filtered.length && <p className="empty-state padded">За вибраними фільтрами карток немає.</p>}</div>
      </aside>
      {current ? <section className="work-desk"><header className="work-desk-head"><div><span>{kindLabels[current.kind]} · {current.code}</span><h2>{current.title}</h2><p>{current.result}</p></div><div className="work-desk-actions"><ProgressRing value={current.progress} />{!["acceptance", "completed"].includes(current.lifecycle) && mayWork && <button className="positive primary-completion" disabled={Boolean(completionReason)} title={completionReason || "Передати результат на приймання"} onClick={() => void completeNode(current)}>Завершити</button>}<details className="work-card-menu"><summary aria-label="Інші дії з карткою">⋮ Дії</summary><div>{mayEditCard && <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void openEdit(current); }}>Редагувати картку</button>}<button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void copyNodeLink(current, "my"); }}>Копіювати посилання</button>{current.kind === "task" && <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); scrollToSection(`asana-link-${current.id}`); }}>Перейти до Asana</button>}<button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openTree(current.id); }}>Паспорт у дереві</button></div></details></div></header><div className="status-line"><StatusBadge node={current} />{current.decisionRequired && <span className="decision-badge">Потрібне рішення</span>}<span>Строк {dateLabel(current.plannedEnd)}</span><span>Прогноз {dateLabel(current.forecastEnd)}</span>{completionReason && <span className="completion-hint">{completionReason}</span>}</div><nav className="work-card-sections" aria-label="Розділи робочої картки"><button onClick={() => scrollToSection(`card-description-${current.id}`)}>Опис</button>{current.kind === "task" && <><button onClick={() => scrollToSection(`work-status-${current.id}`)}>Стан і звіт</button><button onClick={() => scrollToSection(`evidence-${current.id}`)}>Докази</button><button onClick={() => scrollToSection(`asana-link-${current.id}`)}>Asana</button><button onClick={() => scrollToSection(`work-history-${current.id}`)}>Історія</button></>}<button onClick={() => scrollToSection(`discussion-${current.id}`)}>Комунікація</button></nav>
        <div className="work-summary-grid"><article><span>Координатор</span><div className="person-line"><UserAvatar user={userById(current.ownerId)} compact /><strong>{userById(current.ownerId)?.name}</strong></div></article><article><span>Виконавець</span><div className="person-line"><UserAvatar user={userById(current.assigneeId)} compact /><strong>{userById(current.assigneeId)?.name}</strong></div></article><article><span>Керівник вищої ланки</span><div className="person-line"><UserAvatar user={userById(current.acceptorId)} compact /><strong>{userById(current.acceptorId)?.name}</strong></div></article></div>
        <WorkCardDescription node={current} payload={payload} userById={userById} />
        {current.kind === "task" ? <div className="execution-grid"><div><WorkStatusForm key={current.id} node={current} currentUserId={payload.currentUser.id} disabled={!mayWork} notify={setNotice} save={(update) => saveWorkUpdate(current, update)} /><section id={`evidence-${current.id}`} className="work-section section-anchor"><div className="work-section-head"><div><span>Результат</span><h3>Докази та передання</h3></div><button onClick={() => setModal("evidence")}>+ Додати доказ</button></div><p>{current.acceptanceCriteria}</p><div className="evidence-stack">{current.evidence.map((item) => <a key={item.id} href={item.kind === "note" ? undefined : item.value} target="_blank" rel="noreferrer"><b>{item.label}</b><span>{item.kind === "file" ? "Файл" : item.kind === "link" ? "Посилання" : item.value}</span></a>)}{!current.evidence.length && <span className="empty-state">Доказів ще немає.</span>}</div><div className="work-action-row"><button onClick={() => setModal("blocker")}>Додати блокер</button><button onClick={() => setModal("decision")}>Запитати рішення</button><button onClick={() => setModal("dependency")}>Додати залежність</button></div><small className="completion-explainer">Після натискання «Завершити» результат автоматично надсилається координатору та керівнику вищої ланки. Статус «Завершено» і 100% встановлюються після приймання керівником.</small></section></div><aside><AsanaSyncPanel key={`${current.id}-${current.asana.taskGid}`} payload={payload} selected={current} asanaStatus={asanaStatus} mutate={mutate} setNotice={setNotice} compact /><WorkUpdateHistory node={current} userById={userById} /></aside></div> : <div className="aggregate-work"><section className="work-section aggregate-note"><span>Агрегований рівень</span><h3>Стан цього рівня формується з нижчих рівнів</h3><p>{current.kind === "cycle" ? "Зведений стан циклу формується з усіх його підциклів і завдань та є предметом координації." : "Підцикл показує агрегований стан своїх завдань і входить до координації батьківського циклу."}</p>{current.kind === "cycle" && <button className="primary" onClick={() => setModal("coordination")}>Зафіксувати координацію циклу</button>}</section><section className="work-section"><div className="work-section-head"><div><span>Нижчі рівні</span><h3>Джерела стану</h3></div><b>{children.length}</b></div><div className="aggregate-children">{children.map((node) => <button key={node.id} onClick={() => setSelectedId(node.id)}><span>{node.code}</span><strong>{node.title}</strong><em>{node.progress}%</em><StatusBadge node={node} /></button>)}</div></section></div>}
        <OpenBlockersPanel node={current} payload={payload} userById={userById} mutate={mutate} />
        <ManagerActionCenter node={current} payload={payload} latestAcceptance={latestAcceptance} openDecisions={openDecisions} userById={userById} resolveAcceptance={resolveAcceptance} resolveDecision={resolveDecision} mutate={mutate} />
        {decidedDecisions.length > 0 && <section className="work-section decision-workflow"><div className="work-section-head"><div><span>Історія рішень</span><h3>Прийняті управлінські рішення</h3></div><b>{decidedDecisions.length}</b></div>{decidedDecisions.map((decision) => <DecisionActionCard key={decision.id} decision={decision} owner={userById(decision.decisionOwnerId)} canDecide={false} resolve={resolveDecision} />)}</section>}
        <DiscussionPanel node={current} payload={payload} mutate={mutate} notify={setNotice} userById={userById} />
      </section> : <section className="work-desk empty-work"><h2>{mine.length ? "За вибраним фільтром карток немає" : "Робочих карток ще немає"}</h2><p>{mine.length ? "Змініть режим або додаткові фільтри, щоб побачити інші об’єкти." : "Після створення цілі, циклу або завдання доступні вам картки з’являться тут."}</p></section>}
    </div>
  </>;
}

function WorkStatusForm({ node, currentUserId, disabled, save, notify }: { node: WorkNode; currentUserId: string; disabled: boolean; save: (update: Omit<WorkUpdate, "id" | "createdAt" | "createdBy" | "source">) => Promise<boolean>; notify: Notify }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:work-draft:${currentUserId}:${node.id}`, { lifecycle: node.lifecycle, health: node.health, progress: node.progress, forecastEnd: node.forecastEnd, summary: "", nextAction: "" });
  const [busy, setBusy] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  useEffect(() => {
    if (form.summary || form.nextAction) return;
    // Keep untouched controls aligned with automatic updates from other users.
    setForm((current) => ({ ...current, lifecycle: node.lifecycle, health: node.health, progress: node.progress, forecastEnd: node.forecastEnd }));
  }, [form.nextAction, form.summary, node.forecastEnd, node.health, node.lifecycle, node.progress, setForm]);
  const submit = async () => {
    if (node.kind === "task" && form.lifecycle === "completed") {
      setForm({ ...form, lifecycle: node.lifecycle === "completed" ? "completed" : "in_progress" });
      notify("Для завершення завдання використайте кнопку «Завершити»: результат має пройти приймання керівником.", "error");
      return;
    }
    if (!form.summary.trim()) {
      setSummaryError("Опишіть фактичний результат цього звітного кроку.");
      notify("Не вдалося подати звіт: заповніть виділене поле.", "error");
      return;
    }
    setBusy(true);
    const ok = await save(form);
    if (ok) { setForm((current) => ({ ...current, summary: "", nextAction: "" })); clearDraft(); }
    setBusy(false);
  };
  const lifecycleOptions = Object.entries(lifecycleLabels).filter(([value]) => node.kind !== "task" || value !== "completed" || node.lifecycle === "completed");
  return <section className="work-section status-update"><div className="work-section-head"><div><span>Фактичний стан</span><h3>Оновлення та звіт</h3></div><StatusBadge node={{ ...node, lifecycle: form.lifecycle, health: form.health }} /></div><div className="status-form-grid"><Field label="Стан" required hint={node.kind === "task" ? "Оновіть фактичний етап. Для завершення використайте кнопку «Завершити»: результат перейде на приймання керівнику." : "Фактичний етап виконання на момент звіту."}><select value={form.lifecycle} disabled={disabled} onChange={(event) => setForm({ ...form, lifecycle: event.target.value as LifecycleStatus })}>{lifecycleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Стан здоров’я" required hint="Нормально — рух за планом; ризик — строк або результат під загрозою; заблоковано — рух неможливий без окремої реакції."><select value={form.health} disabled={disabled} onChange={(event) => setForm({ ...form, health: event.target.value as HealthStatus })}>{Object.entries(healthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={`Прогрес · ${form.progress}%`} required hint="Оцініть частку вже отриманого результату, а не витрачений час."><input type="range" min="0" max="100" value={form.progress} disabled={disabled} onChange={(event) => setForm({ ...form, progress: Number(event.target.value) })} /></Field><Field label="Прогноз завершення" hint="Оновіть дату, якщо фактичний прогноз відрізняється від планового строку."><input type="date" value={form.forecastEnd} disabled={disabled} onChange={(event) => setForm({ ...form, forecastEnd: event.target.value })} /></Field><Field wide label="Що зроблено / фактичний результат" required error={summaryError} hint="Фіксуйте перевірюваний результат, а не процес або витрачений час." example="Оновлено сторінку послуги, перевірено 12 посилань, передано на погодження власнику результату."><textarea value={form.summary} disabled={disabled} aria-invalid={Boolean(summaryError)} onChange={(event) => { setForm({ ...form, summary: event.target.value }); setSummaryError(""); }} placeholder="Наприклад: підготовлено макет і передано на погодження" /></Field><Field wide label="Наступна дія" hint="Наступний конкретний крок, відповідальний та умова або строк." example="До 18.08 Валентина вносить правки після погодження Володимира."><textarea value={form.nextAction} disabled={disabled} onChange={(event) => setForm({ ...form, nextAction: event.target.value })} placeholder="Наприклад: внести правки після погодження власника" /></Field></div><button className="primary full-action" disabled={disabled || busy} onClick={() => void submit()}>{busy ? "Зберігаємо…" : "Зберегти стан і подати звіт"}</button></section>;
}

function WorkUpdateHistory({ node, userById }: { node: WorkNode; userById: (id: string) => PortalUser | undefined }) {
  return <section className="work-section update-panel"><div className="work-section-head"><div><span>Системний слід</span><h3>Останні звіти</h3></div><b>{(node.updates || []).length}</b></div><div className="update-history">{(node.updates || []).slice(0, 8).map((update) => <article key={update.id}><time>{new Date(update.createdAt).toLocaleString("uk-UA")}</time><strong>{lifecycleLabels[update.lifecycle]} · {update.progress}%</strong><p>{update.summary}</p><small>{userById(update.createdBy)?.name || "Asana"}{update.nextAction ? ` · Далі: ${update.nextAction}` : ""}</small></article>)}{!(node.updates || []).length && <p className="empty-state">Звітів ще немає.</p>}</div></section>;
}

function WorkCardDescription({ node, payload, userById }: { node: WorkNode; payload: PortalPayload; userById: (id: string) => PortalUser | undefined }) {
  const path = nodePath(payload.nodes, node);
  const participants = node.participantIds.map((id) => userById(id)?.name).filter(Boolean).join(", ");
  const value = (text: string) => text.trim() || "Не визначено";
  return <details className="work-card-description"><summary><div><span>Паспорт робочої картки</span><strong>Опис картки</strong><small>{path.map((item) => item.code).join(" / ")} · {node.description || node.result}</small></div><i className="details-state" aria-hidden="true" /></summary><div className="work-card-description-body"><section><h4>Місце в структурі</h4><dl><dt>Шлях</dt><dd>{path.map((item) => `${item.code} · ${item.title}`).join(" → ")}</dd><dt>Рівень</dt><dd>{kindLabels[node.kind]}</dd><dt>Код і назва</dt><dd>{node.code} · {node.title}</dd></dl></section><section><h4>Результат і межі</h4><dl><dt>Опис</dt><dd>{value(node.description)}</dd><dt>Готовий результат</dt><dd>{value(node.result)}</dd><dt>Що не є результатом</dt><dd>{value(node.nonResult)}</dd><dt>Критерій приймання</dt><dd>{value(node.acceptanceCriteria)}</dd></dl></section><section><h4>Відповідальні</h4><dl><dt>Координатор</dt><dd>{userById(node.ownerId)?.name || "Не визначено"}</dd><dt>Виконавець</dt><dd>{userById(node.assigneeId)?.name || "Не визначено"}</dd><dt>Керівник вищої ланки</dt><dd>{userById(node.acceptorId)?.name || "Не визначено"}</dd><dt>Учасники / фоловери</dt><dd>{participants || "Не визначено"}</dd></dl></section><section><h4>Строки та стан</h4><dl><dt>Дата початку</dt><dd>{dateLabel(node.plannedStart)}</dd><dt>Дедлайн до</dt><dd>{dateLabel(node.plannedEnd)}</dd><dt>Прогноз завершення</dt><dd>{dateLabel(node.forecastEnd)}</dd><dt>Статус</dt><dd>{lifecycleLabels[node.lifecycle]} · {node.progress}%</dd><dt>Стан виконання</dt><dd>{healthLabels[node.health]}</dd><dt>Пріоритет</dt><dd>{priorityLabels[node.priority]}</dd></dl></section><section><h4>Умови виконання</h4><dl><dt>Спосіб початку</dt><dd>{startLabels[node.startMode]}</dd><dt>Повноваження</dt><dd>{value(node.authority)}</dd><dt>Ресурс</dt><dd>{value(node.resource)}</dd><dt>Контрольне місце</dt><dd>{value(node.controlPlace)}</dd><dt>Доступ</dt><dd>{node.visibility === "company" ? "Уся компанія" : "Лише учасники"}</dd>{node.kind === "cycle" && <><dt>Координація</dt><dd>{coordinationCadenceLabel(node)}</dd></>}</dl></section></div></details>;
}

function AcceptanceActionBox({ node, acceptance, resolve }: { node: WorkNode; acceptance: Acceptance; resolve: (acceptance: Acceptance, accepted: boolean, feedback?: string) => Promise<boolean> }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (accepted: boolean) => {
    if (!accepted && !feedback.trim()) return;
    setBusy(true);
    await resolve(acceptance, accepted, feedback);
    setBusy(false);
  };
  return <div className="acceptance-box detailed"><div><span>Результат очікує приймання</span><strong>Критерій: {node.acceptanceCriteria || "не визначено"}</strong><small>{acceptance.evidenceNote ? `Докази: ${acceptance.evidenceNote}` : "Докази не додані"}</small><textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Коментар до приймання або обов’язкова причина повернення…" /></div><div><button className="negative" disabled={busy || !feedback.trim()} onClick={() => void act(false)}>Повернути з коментарем</button><button className="positive" disabled={busy} onClick={() => void act(true)}>Прийняти результат</button></div></div>;
}

function DecisionActionCard({ decision, owner, canDecide, resolve }: { decision: Decision; owner?: PortalUser; canDecide: boolean; resolve: (decision: Decision, resolution: string) => Promise<boolean> }) {
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (value: string) => { if (!value.trim()) return; setBusy(true); await resolve(decision, value); setBusy(false); };
  return <article className={`decision-action-card ${decision.status}`}><header><div><span>Вирішує: {owner?.name || "не визначено"}</span><strong>{decision.question}</strong></div><time>{decision.status === "decided" ? `Прийнято ${decision.decidedAt ? new Date(decision.decidedAt).toLocaleString("uk-UA") : ""}` : `до ${dateLabel(decision.dueDate)}`}</time></header><dl><dt>Варіанти</dt><dd>{decision.options || "Варіанти не зазначені"}</dd><dt>Рекомендація автора</dt><dd>{decision.recommendation || "Рекомендація не зазначена"}</dd>{decision.status === "decided" && <><dt className="resolution-label">Прийняте рішення</dt><dd className="resolution-value">{decision.resolution || "Рішення не зафіксовано"}</dd></>}</dl>{canDecide ? <div><label className="decision-resolution-field"><span>Прийняття рішення</span><textarea value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="Запишіть прийняте рішення та, за потреби, умови виконання…" /></label><div><button disabled={busy || !decision.recommendation.trim()} onClick={() => void submit(decision.recommendation)}>Прийняти рекомендацію</button><button className="primary" disabled={busy || !resolution.trim()} onClick={() => void submit(resolution)}>Зафіксувати інше рішення</button></div></div> : decision.status === "requested" ? <small>Очікується відповідь уповноваженої особи.</small> : null}</article>;
}

function BlockerApprovalCard({ blocker, resolve }: { blocker: Blocker; resolve: (blocker: Blocker, approved: boolean, comment: string) => Promise<boolean> }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (approved: boolean) => { if (!comment.trim()) return; setBusy(true); await resolve(blocker, approved, comment); setBusy(false); };
  return <article className="blocker-approval-card"><header><span>Підтвердження статусу блокера</span><strong>{blocker.title}</strong><time>до {dateLabel(blocker.decisionDue)}</time></header><dl><dt>Факти</dt><dd>{blocker.facts}</dd><dt>Рекомендація</dt><dd>{blocker.recommendation || "Не вказана"}</dd><dt>Наслідок без рішення</dt><dd>{blocker.impact || "Не вказаний"}</dd></dl><label className="blocker-response-field"><span>Коментар до рішення *</span><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Для погодження — підтвердження або умови; для відмови — альтернативний варіант чи пояснення, чому це не блокер." /></label><div><button className="reject-blocker" disabled={busy || !comment.trim()} onClick={() => void act(false)}>Відмовлено</button><button className="approve-blocker" disabled={busy || !comment.trim()} onClick={() => void act(true)}>Погоджую</button></div><small className="blocker-decision-help">«Погоджую» залишає картку заблокованою. «Відмовлено» знімає цей блокер після збереження пояснення.</small></article>;
}

function OpenBlockersPanel({ node, payload, userById, mutate }: { node: WorkNode; payload: PortalPayload; userById: (id: string) => PortalUser | undefined; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean> }) {
  const blockers = payload.blockers.filter((item) => item.nodeId === node.id && item.status === "open");
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState("");
  if (!blockers.length) return null;
  const administrator = ["owner", "admin"].includes(payload.currentUser.role);
  const resolve = async (blocker: Blocker) => {
    const comment = comments[blocker.id]?.trim();
    if (!comment) return;
    setBusyId(blocker.id);
    await mutate(`Блокер усунено в ${node.code}`, node.id, (state) => {
      const target = state.blockers.find((item) => item.id === blocker.id)!;
      target.status = "resolved";
      target.resolvedAt = isoNow();
      const targetNode = state.nodes.find((item) => item.id === node.id)!;
      const hasOther = state.blockers.some((item) => item.nodeId === node.id && item.id !== blocker.id && item.status === "open");
      if (!hasOther) targetNode.health = "normal";
      targetNode.decisionRequired = hasOther || state.decisions.some((item) => item.nodeId === node.id && item.status === "requested");
      state.discussions.unshift({ id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, recipientId: blocker.escalationToId, text: `Блокер усунено: ${comment}`, kind: "approval", createdAt: isoNow() });
    });
    setBusyId("");
  };
  return <section id={`blockers-${node.id}`} className="work-section open-blockers-panel section-anchor"><div className="work-section-head"><div><span>Контроль відхилень</span><h3>Відкриті блокери</h3></div><b>{blockers.length}</b></div><div className="open-blocker-list">{blockers.map((blocker) => { const mayResolve = administrator || blocker.ownerId === payload.currentUser.id || node.ownerId === payload.currentUser.id || node.assigneeId === payload.currentUser.id; return <article key={blocker.id}><header><div><span>{blocker.approvalStatus === "approved" ? "Підтверджено" : "Очікує погодження"}</span><strong>{blocker.title}</strong></div><time>реакція до {dateLabel(blocker.decisionDue)}</time></header><p>{blocker.facts}</p><dl><dt>Відповідальний</dt><dd>{userById(blocker.ownerId)?.name || "Не визначено"}</dd><dt>Ескалація</dt><dd>{userById(blocker.escalationToId)?.name || "Не визначено"}</dd>{blocker.approvalComment && <><dt>Коментар погодження</dt><dd>{blocker.approvalComment}</dd></>}</dl>{mayResolve ? <div className="blocker-resolution"><textarea value={comments[blocker.id] || ""} onChange={(event) => setComments((current) => ({ ...current, [blocker.id]: event.target.value }))} placeholder="Що зроблено і чому блокер більше не зупиняє роботу…" /><button disabled={busyId === blocker.id || !comments[blocker.id]?.trim()} onClick={() => void resolve(blocker)}>Позначити усуненим</button></div> : <small>Усунення фіксує відповідальний за блокер, виконавець або координатор картки.</small>}</article>; })}</div></section>;
}

function ManagerActionCenter({ node, payload, latestAcceptance, openDecisions, userById, resolveAcceptance, resolveDecision, mutate }: { node: WorkNode; payload: PortalPayload; latestAcceptance?: Acceptance; openDecisions: Decision[]; userById: (id: string) => PortalUser | undefined; resolveAcceptance: (acceptance: Acceptance, accepted: boolean, feedback?: string) => Promise<boolean>; resolveDecision: (decision: Decision, resolution: string) => Promise<boolean>; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean> }) {
  const isAdministrator = ["owner", "admin"].includes(payload.currentUser.role);
  const blockers = payload.blockers.filter((item) => item.nodeId === node.id && item.status === "open" && (!item.approvalStatus || item.approvalStatus === "pending") && (isAdministrator || item.escalationToId === payload.currentUser.id));
  const decisions = openDecisions.filter((item) => isAdministrator || item.decisionOwnerId === payload.currentUser.id);
  const acceptance = latestAcceptance && (isAdministrator || latestAcceptance.acceptorId === payload.currentUser.id) ? latestAcceptance : undefined;
  const receivingParty = blockers.length > 0 || decisions.length > 0 || Boolean(acceptance);
  if (!receivingParty) return null;
  const resolveBlocker = (blocker: Blocker, approved: boolean, comment: string) => mutate(approved ? `Підтверджено блокер ${node.code}` : `Відмовлено у статусі блокера ${node.code}`, node.id, (state) => {
    const target = state.blockers.find((item) => item.id === blocker.id)!;
    target.approvalStatus = approved ? "approved" : "rejected";
    target.approvalComment = comment.trim();
    target.approvedBy = payload.currentUser.id;
    target.approvedAt = isoNow();
    if (!approved) {
      target.status = "resolved";
      target.resolvedAt = isoNow();
      const hasOtherBlocker = state.blockers.some((item) => item.nodeId === node.id && item.id !== target.id && item.status === "open");
      const targetNode = state.nodes.find((item) => item.id === node.id)!;
      if (!hasOtherBlocker) targetNode.health = "normal";
      targetNode.decisionRequired = hasOtherBlocker || state.decisions.some((item) => item.nodeId === node.id && item.status === "requested");
    }
    state.discussions.unshift({ id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, recipientId: blocker.ownerId, text: `${approved ? "Статус блокера погоджено" : "У статусі блокера відмовлено"}: ${target.approvalComment}`, kind: "approval", createdAt: isoNow() });
  });
  return <section id={`manager-actions-${node.id}`} className="work-section manager-action-center"><div className="work-section-head"><div><span>Приймальна сторона</span><h3>Дії уповноваженої особи</h3></div><b>{blockers.length + decisions.length + (acceptance ? 1 : 0)}</b></div><div className="manager-action-groups"><section><h4>Погодження блокера</h4>{blockers.map((blocker) => <BlockerApprovalCard key={blocker.id} blocker={blocker} resolve={resolveBlocker} />)}{!blockers.length && <p className="empty-state">Блокерів, що очікують погодження, немає.</p>}</section><section><h4>Прийняття рішення</h4>{decisions.map((decision) => <DecisionActionCard key={decision.id} decision={decision} owner={userById(decision.decisionOwnerId)} canDecide resolve={resolveDecision} />)}{!decisions.length && <p className="empty-state">Рішень, що очікують вибору, немає.</p>}</section><section><h4>Приймання завершення завдання</h4>{acceptance ? <AcceptanceActionBox node={node} acceptance={acceptance} resolve={resolveAcceptance} /> : <p className="empty-state">Завершення ще не передано на приймання.</p>}</section></div></section>;
}

function DiscussionPanel({ node, payload, mutate, notify, userById }: { node: WorkNode; payload: PortalPayload; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; notify: Notify; userById: (id: string) => PortalUser | undefined }) {
  const [draft, setDraft, clearDraft] = usePersistentDraft(`portal:discussion-draft:${payload.currentUser.id}:${node.id}`, { text: "", kind: "comment" as "comment" | "question", recipientId: node.ownerId, requiresResponse: false });
  const [busy, setBusy] = useState(false);
  const [replyToId, setReplyToId] = useState("");
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingText, setEditingText] = useState("");
  const messages = (payload.discussions || []).filter((message) => message.nodeId === node.id && !message.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const replyTo = messages.find((message) => message.id === replyToId);
  const effectiveRecipientId = draft.recipientId || node.ownerId;
  const send = async () => {
    if (!draft.text.trim()) { notify("Напишіть повідомлення для учасників картки.", "error"); return; }
    if ((draft.kind === "question" || draft.requiresResponse) && !effectiveRecipientId) { notify("Оберіть адресата повідомлення.", "error"); return; }
    setBusy(true);
    const message: DiscussionMessage = { id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, recipientId: replyTo?.authorId || (draft.kind === "question" || draft.requiresResponse ? effectiveRecipientId : undefined), replyToId: replyTo?.id, requiresResponse: !replyTo && (draft.kind === "question" || draft.requiresResponse), text: draft.text.trim(), kind: draft.kind, createdAt: isoNow() };
    const ok = await mutate(`${replyTo ? "Додано відповідь" : draft.kind === "question" ? "Поставлено питання" : "Додано коментар"} до ${node.code}`, node.id, (state) => {
      state.discussions.push(message);
      if (replyTo) { const original = state.discussions.find((item) => item.id === replyTo.id); if (original) { original.resolvedAt = isoNow(); original.resolvedBy = payload.currentUser.id; } }
    });
    if (ok) { setDraft({ text: "", kind: "comment", recipientId: node.ownerId, requiresResponse: false }); setReplyToId(""); clearDraft(); }
    setBusy(false);
  };
  const resolveQuestion = (message: DiscussionMessage) => mutate(`Закрито питання в ${node.code}`, node.id, (state) => { const target = state.discussions.find((item) => item.id === message.id); if (target) { target.resolvedAt = isoNow(); target.resolvedBy = payload.currentUser.id; } });
  const mayChangeMessage = (message: DiscussionMessage) => ["comment", "question"].includes(message.kind) && (message.authorId === payload.currentUser.id || node.ownerId === payload.currentUser.id || ["owner", "admin"].includes(payload.currentUser.role));
  const saveMessageEdit = async (message: DiscussionMessage) => {
    if (!editingText.trim()) { notify("Текст повідомлення не може бути порожнім.", "error"); return; }
    const ok = await mutate(`Відредаговано повідомлення в ${node.code}`, node.id, (state) => { const target = state.discussions.find((item) => item.id === message.id); if (target) { target.text = editingText.trim(); target.editedAt = isoNow(); target.editedBy = payload.currentUser.id; } });
    if (ok) { setEditingMessageId(""); setEditingText(""); }
  };
  const deleteMessage = async (message: DiscussionMessage) => {
    if (!window.confirm("Видалити це повідомлення з обговорення? Запис про дію залишиться в журналі змін.")) return;
    await mutate(`Видалено повідомлення з ${node.code}`, node.id, (state) => { const target = state.discussions.find((item) => item.id === message.id); if (target) { target.deletedAt = isoNow(); target.deletedBy = payload.currentUser.id; target.resolvedAt = target.resolvedAt || target.deletedAt; target.resolvedBy = target.resolvedBy || payload.currentUser.id; } });
  };
  return <section id={`discussion-${node.id}`} className="work-section discussion-panel">
    <div className="work-section-head"><div><span>Внутрішня комунікація</span><h3>Питання, рішення, погодження та коментарі</h3></div><b>{messages.length}</b></div>
    <div className="discussion-list">{messages.slice(-30).map((message) => {
      const awaitingResponse = !message.resolvedAt && (message.kind === "question" || message.requiresResponse);
      const editing = editingMessageId === message.id;
      return <article key={message.id} className={`${message.kind} ${message.resolvedAt ? "resolved" : ""}`}><div><UserAvatar compact user={userById(message.authorId)} /><strong>{userById(message.authorId)?.name || "Система"}</strong>{message.recipientId && <span className="message-recipient">→ {userById(message.recipientId)?.name || "адресат"}</span>}{message.kind === "question" && <span className="question-state">{message.resolvedAt ? "Відповідь отримано" : "Відкрите питання"}</span>}{message.kind === "comment" && message.requiresResponse && <span className="question-state">{message.resolvedAt ? "Відповідь отримано" : "Очікує відповіді"}</span>}{message.kind === "decision" && <span className="question-state">{message.resolvedAt ? "Рішення прийнято" : "Очікує рішення"}</span>}<time>{new Date(message.createdAt).toLocaleString("uk-UA")}{message.editedAt ? " · змінено" : ""}</time>{mayChangeMessage(message) && !editing && <div className="message-actions"><button onClick={() => { setEditingMessageId(message.id); setEditingText(message.text); }}>Редагувати</button><button className="delete" onClick={() => void deleteMessage(message)}>Видалити</button></div>}</div>{message.replyToId && <small className="reply-reference">Відповідь на попереднє повідомлення</small>}{editing ? <div className="message-edit-form"><textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} /><div><button onClick={() => { setEditingMessageId(""); setEditingText(""); }}>Скасувати</button><button className="primary" onClick={() => void saveMessageEdit(message)}>Зберегти зміни</button></div></div> : <p>{message.text}</p>}{awaitingResponse && !editing && <div className="question-actions"><button onClick={() => { setReplyToId(message.id); setDraft({ ...draft, kind: "comment", recipientId: message.authorId, requiresResponse: false }); }}>Відповісти</button><button className="resolve-question" onClick={() => void resolveQuestion(message)}>Закрити без відповіді</button></div>}</article>;
    })}{!messages.length && <p className="empty-state">Повідомлень ще немає. Уся комунікація зберігатиметься в картці та у «Вхідних» адресатів.</p>}</div>
    {replyTo && <div className="reply-banner"><span>Відповідь для {userById(replyTo.authorId)?.name}</span><strong>{replyTo.text}</strong><button onClick={() => setReplyToId("")}>×</button></div>}
    <div className="discussion-compose expanded"><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as "comment" | "question", requiresResponse: event.target.value === "question" })}><option value="comment">Коментар</option><option value="question">Питання</option></select>{(draft.kind === "question" || draft.requiresResponse) && !replyTo && <select value={effectiveRecipientId} onChange={(event) => setDraft({ ...draft, recipientId: event.target.value })} aria-label="Адресат повідомлення">{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select>}{draft.kind === "comment" && !replyTo && <label className="comment-response-toggle"><input type="checkbox" checked={Boolean(draft.requiresResponse)} onChange={(event) => setDraft({ ...draft, requiresResponse: event.target.checked })} /><span>Очікую відповідь</span></label>}<textarea value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} placeholder={replyTo ? "Напишіть відповідь…" : "Напишіть питання або коментар…"} /><button className="primary" disabled={busy || !draft.text.trim()} onClick={() => void send()}>{busy ? "Надсилаємо…" : replyTo ? "Відповісти" : "Надіслати"}</button></div>
  </section>;
}

function CoordinationView({ payload, userById, select, open }: { payload: PortalPayload; userById: (id: string) => PortalUser | undefined; select: (id: string) => void; open: (node: WorkNode) => void }) {
  const [query, setQuery] = useState("");
  const [ownerId, setOwnerId] = useState("all");
  const [state, setState] = useState<"all" | "risk" | "active" | "completed">("all");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const activeNodes = payload.nodes.filter((node) => !node.archived);
  const units = payload.nodes.filter((node) => node.kind === "cycle" && !node.archived).map((node) => {
    const branch = descendants(activeNodes, node.id);
    return { node, branch, subcycles: branch.filter((item) => item.kind === "subcycle"), tasks: branch.filter((item) => item.kind === "task") };
  }).filter(({ branch }) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery || branch.some((item) => `${item.code} ${item.title}`.toLowerCase().includes(normalizedQuery));
    const matchesExecutorAndState = branch.some((item) => (ownerId === "all" || item.assigneeId === ownerId)
      && (state === "all" || state === "risk" && coordinationAttentionReasons(payload, item).length > 0 || state === "active" && !["completed", "cancelled"].includes(item.lifecycle) || state === "completed" && item.lifecycle === "completed"));
    return matchesQuery && matchesExecutorAndState;
  });
  const scopeIds = new Set(units.flatMap(({ node, branch }) => [...nodePath(payload.nodes, node).map((item) => item.id), ...branch.map((item) => item.id)]));
  const attentionNodes = activeNodes.map((node) => ({ node, reasons: coordinationAttentionReasons(payload, node) })).filter(({ node, reasons }) => scopeIds.has(node.id) && reasons.length && (ownerId === "all" || node.assigneeId === ownerId));
  const filtersActive = Boolean(query.trim() || ownerId !== "all" || state !== "all");
  const tableIds = new Set<string>();
  const matchesTableFilter = (node: WorkNode) => {
    const normalizedQuery = query.trim().toLowerCase();
    return (!normalizedQuery || `${node.code} ${node.title} ${node.result}`.toLowerCase().includes(normalizedQuery))
      && (ownerId === "all" || node.assigneeId === ownerId)
      && (state === "all" || state === "risk" && coordinationAttentionReasons(payload, node).length > 0 || state === "active" && !["completed", "cancelled"].includes(node.lifecycle) || state === "completed" && node.lifecycle === "completed");
  };
  for (const { branch } of units) {
    for (const node of branch) {
      if (!filtersActive || matchesTableFilter(node)) {
        tableIds.add(node.id);
        for (const ancestor of nodePath(payload.nodes, node)) tableIds.add(ancestor.id);
      }
    }
  }
  const goals = activeNodes.filter((node) => node.kind === "goal" && units.some((unit) => unit.node.parentId === node.id));
  const orphanCycles = units.filter((unit) => !unit.node.parentId || !goals.some((goal) => goal.id === unit.node.parentId)).map((unit) => unit.node);
  const toggleRow = (id: string) => setExpandedRows((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const structureIds = activeNodes.filter((node) => tableIds.has(node.id) && node.kind !== "task").map((node) => node.id);
  const reportIds = activeNodes.filter((node) => tableIds.has(node.id) && node.kind === "task" && (node.updates || []).length > 0).map((node) => node.id);
  const allExpandableIds = [...new Set([...structureIds, ...reportIds])];
  const structureExpanded = structureIds.length > 0 && structureIds.every((id) => expandedRows.has(id));
  const reportsExpanded = reportIds.length > 0 && reportIds.every((id) => expandedRows.has(id));
  const everythingExpanded = allExpandableIds.length > 0 && allExpandableIds.every((id) => expandedRows.has(id));
  const toggleStructure = () => setExpandedRows((current) => { const next = new Set(current); for (const id of structureIds) { if (structureExpanded) next.delete(id); else next.add(id); } return next; });
  const toggleReports = () => setExpandedRows((current) => { const next = new Set(current); if (reportsExpanded) { for (const id of reportIds) next.delete(id); } else { for (const id of [...structureIds, ...reportIds]) next.add(id); } return next; });
  const toggleEverything = () => setExpandedRows(everythingExpanded ? new Set() : new Set(allExpandableIds));
  const childNodes = (node: WorkNode) => {
    if (node.kind === "goal") return units.map((unit) => unit.node).filter((cycle) => cycle.parentId === node.id);
    return activeNodes.filter((candidate) => candidate.parentId === node.id && (candidate.kind === "subcycle" || candidate.kind === "task") && tableIds.has(candidate.id));
  };
  const renderCoordinationRow = (node: WorkNode, depth = 0): React.ReactNode => {
    const children = childNodes(node);
    const reports = node.kind === "task" ? [...(node.updates || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3) : [];
    const hasChildren = children.length > 0 || reports.length > 0;
    const opened = expandedRows.has(node.id);
    const reasons = coordinationAttentionReasons(payload, node);
    return <div key={node.id} className={`coordination-tree-branch level-${node.kind}`}>
      <div className="coordination-tree-row" style={{ "--coord-depth": depth } as React.CSSProperties}>
        <div className="coordination-object-cell"><button className="coordination-expand" disabled={!hasChildren} onClick={() => toggleRow(node.id)} aria-label={opened ? "Згорнути рівень" : "Розгорнути рівень"}>{hasChildren ? opened ? "⌄" : "›" : "·"}</button><button className="coordination-object" onClick={() => select(node.id)}><span>{node.code}</span><strong>{node.title}</strong><small>{node.kind === "cycle" ? `${payload.nodes.find((item) => item.id === node.parentId)?.code || "Без цілі"} · ${coordinationCadenceLabel(node)}` : kindLabels[node.kind]}</small></button></div>
        <span className="coordination-owner">{userById(node.assigneeId)?.name || "—"}</span><StatusBadge node={node} /><span className="coordination-progress">{node.progress}%</span><time>{dateLabel(node.plannedEnd)}</time><div className="coordination-row-attention">{reasons.slice(0, 2).map((reason) => <span key={reason}>{reason}</span>)}{reasons.length > 2 && <b>+{reasons.length - 2}</b>}{node.kind === "cycle" && <button onClick={() => open(node)}>Координація</button>}</div>
      </div>
      {opened && children.map((child) => renderCoordinationRow(child, depth + 1))}
      {opened && reports.map((report) => <div className="coordination-report-row" key={report.id} style={{ "--coord-depth": depth + 1 } as React.CSSProperties}><div><span>{new Date(report.createdAt).toLocaleString("uk-UA")}</span><strong>{report.summary}</strong><small>{userById(report.createdBy)?.name || "Asana"}</small></div><span>{lifecycleLabels[report.lifecycle]}</span><span>{report.progress}%</span><span>{report.forecastEnd ? dateLabel(report.forecastEnd) : "Без прогнозу"}</span><p>{report.nextAction || "Наступну дію не вказано"}</p></div>)}
    </div>;
  };
  return <><PageIntro kicker="Одиниця координації" title="Координація за управлінськими циклами" text="Предмет координації — зведений стан усіх завдань циклу з розрізом за підциклами, строками, блокерами, рішеннями та прийманням." actions={<div className="page-filter-bar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Пошук циклу, підциклу або завдання…" /><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="all">Усі виконавці</option>{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><select value={state} onChange={(event) => setState(event.target.value as typeof state)}><option value="all">Усі стани</option><option value="active">Активні об’єкти</option><option value="risk">Потребує координації</option><option value="completed">Завершені об’єкти</option></select></div>} />
    <section className="panel coordination-attention"><div className="panel-head"><div><span>Контроль і реакція</span><h2>Потребує координації</h2></div><b className="count amber">{attentionNodes.length}</b></div><div className="coordination-attention-table"><div className="coordination-attention-head"><span>Об’єкт</span><span>Причини</span><span>Відповідальний</span><span>Строк</span></div>{attentionNodes.map(({ node, reasons }) => <button key={node.id} onClick={() => select(node.id)}><div><span>{node.code} · {kindLabels[node.kind]}</span><strong>{node.title}</strong></div><div>{reasons.map((reason) => <span key={reason}>{reason}</span>)}</div><span>{userById(node.assigneeId)?.name || "—"}</span><time>{dateLabel(node.plannedEnd)}</time></button>)}{!attentionNodes.length && <p className="empty-state padded">За вибраними фільтрами немає об’єктів, що потребують координації.</p>}</div></section>
    <section className="panel coordination-tree-table"><div className="panel-head"><div><span>Зведена звітність циклів</span><h2>Стратегічна ціль → управлінський цикл → підцикл → завдання → три останні звіти</h2></div><div className="coordination-tree-controls"><button className={structureExpanded ? "active" : ""} onClick={toggleStructure}>{structureExpanded ? "Згорнути рівні" : "Розгорнути рівні"}</button><button className={reportsExpanded ? "active" : ""} disabled={!reportIds.length} onClick={toggleReports}>{reportsExpanded ? "Сховати звіти" : "Показати звіти"}</button><button className={everythingExpanded ? "active" : ""} disabled={!allExpandableIds.length} onClick={toggleEverything}>{everythingExpanded ? "Згорнути все" : "Розгорнути все"}</button><b className="count">{units.length}</b></div></div><div className="coordination-tree-head"><span>Об’єкт управління</span><span>Відповідальний</span><span>Статус</span><span>Прогрес</span><span>Строк</span><span>Увага / дія</span></div><div className="coordination-tree-body">{goals.map((goal) => renderCoordinationRow(goal))}{orphanCycles.map((cycle) => renderCoordinationRow(cycle))}{!units.length && <p className="empty-state padded">За вибраними фільтрами управлінських циклів немає.</p>}</div></section>
  </>;
}

function RiskRegisters({ payload, userById, openWork }: { payload: PortalPayload; userById: (id: string) => PortalUser | undefined; openWork: (id: string) => void }) {
  const openBlockers = payload.blockers.filter((item) => item.status === "open");
  const openDecisions = payload.decisions.filter((item) => item.status === "requested");
  return <div className="risk-layout"><section className="panel"><div className="panel-head"><div><span>Блокери</span><h2>Відкриті перешкоди</h2></div><b className="count red">{openBlockers.length}</b></div><div className="register-list">{openBlockers.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <article key={item.id}><div className="register-top"><button onClick={() => openWork(item.nodeId)}>{node?.code}</button><span>до {dateLabel(item.decisionDue)}</span></div><h3>{item.title}</h3><p>{item.facts}</p><dl><dt>Рекомендація</dt><dd>{item.recommendation}</dd><dt>Ескалація</dt><dd>{userById(item.escalationToId)?.name}</dd></dl><button className="open-work-action" onClick={() => openWork(item.nodeId)}>Відкрити робочу картку</button></article>; })}{!openBlockers.length && <p className="empty-state padded">Відкритих блокерів немає.</p>}</div></section>
      <section className="panel"><div className="panel-head"><div><span>Рішення</span><h2>Очікують рішення</h2></div><b className="count amber">{openDecisions.length}</b></div><div className="register-list">{openDecisions.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <article key={item.id}><div className="register-top"><button onClick={() => openWork(item.nodeId)}>{node?.code}</button><span>до {dateLabel(item.dueDate)}</span></div><h3>{item.question}</h3><p>{item.options}</p><dl><dt>Рекомендація</dt><dd>{item.recommendation}</dd><dt>Приймає рішення</dt><dd>{userById(item.decisionOwnerId)?.name}</dd></dl><button className="open-work-action" onClick={() => openWork(item.nodeId)}>Відкрити робочу картку</button></article>; })}{!openDecisions.length && <p className="empty-state padded">Відкритих рішень немає.</p>}</div></section></div>
  ;
}

function ReportAnalytics({ payload, data, userById, healthFilter, setHealthFilter, query, ownerId, openWork }: { payload: PortalPayload; data: ComputedData; userById: (id: string) => PortalUser | undefined; healthFilter: "all" | HealthStatus | "overdue" | "decision"; setHealthFilter: (value: "all" | HealthStatus | "overdue" | "decision") => void; query: string; ownerId: string; openWork: (id: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const filtered = data.tasks.filter((node) => (healthFilter === "all" || node.health === healthFilter || (healthFilter === "overdue" && node.plannedEnd < today && node.lifecycle !== "completed") || (healthFilter === "decision" && node.decisionRequired)) && (ownerId === "all" || node.ownerId === ownerId || node.assigneeId === ownerId) && (!query.trim() || `${node.code} ${node.title} ${node.result}`.toLowerCase().includes(query.trim().toLowerCase())));
  const perUser = payload.users.filter((user) => user.active).map((user) => ({ user, tasks: data.tasks.filter((node) => node.assigneeId === user.id && node.lifecycle !== "completed"), blocked: data.tasks.filter((node) => node.assigneeId === user.id && node.health === "blocked").length }));
  const exportCsv = () => {
    const rows = [["Код", "Завдання", "Виконавець", "Стан", "Прогрес", "Плановий строк"], ...filtered.map((node) => [node.code, node.title, userById(node.assigneeId)?.name || "", healthLabels[node.health], String(node.progress), node.plannedEnd])];
    const csv = `\ufeff${rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(";")).join("\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `управлінський-звіт-${today}.csv`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <><div className="dashboard-actions"><button className="secondary" onClick={() => window.print()}>Друк / PDF</button><button className="primary" onClick={exportCsv}>Вивантажити таблицю</button></div>
    <div className="report-metrics"><article><span>Виконання у строк</span><strong>{data.onTimeRate}%</strong><small>серед завершених задач</small></article><article><span>Приймання з першого разу</span><strong>{data.firstPassRate}%</strong><small>{data.returnedCount} повернень</small></article><article><span>Середній прогрес задач</span><strong>{data.tasks.length ? Math.round(data.tasks.reduce((sum, node) => sum + node.progress, 0) / data.tasks.length) : 0}%</strong><small>не замінює результат цілі</small></article><article><span>Відкриті рішення</span><strong>{data.decisions.length}</strong><small>із визначеним адресатом</small></article></div>
    <div className="report-grid"><section className="panel"><div className="panel-head"><div><span>Навантаження</span><h2>Активні задачі за виконавцями</h2></div></div><div className="bar-chart">{perUser.map(({ user, tasks, blocked }) => <div className="bar-row" key={user.id}><div><UserAvatar user={user} compact /><span>{user.name}</span></div><i><b style={{ width: `${Math.min(100, tasks.length * 20)}%` }} /></i><strong>{tasks.length}</strong>{blocked > 0 && <em>{blocked} бл.</em>}</div>)}</div></section>
      <section className="panel"><div className="panel-head"><div><span>Стани</span><h2>Розподіл завдань</h2></div></div><div className="distribution">{(["planned", "ready", "in_progress", "acceptance", "completed"] as LifecycleStatus[]).map((status) => { const count = data.tasks.filter((node) => node.lifecycle === status).length; return <div key={status}><span>{lifecycleLabels[status]}</span><i><b style={{ width: `${data.tasks.length ? count / data.tasks.length * 100 : 0}%` }} /></i><strong>{count}</strong></div>; })}</div></section></div>
    <section id="control-register" className="panel report-table"><div className="report-filter"><div><h2>Контрольний реєстр</h2><span>{filtered.length} завдань</span></div><div>{(["all", "blocked", "risk", "overdue", "decision"] as const).map((filter) => <button key={filter} className={healthFilter === filter ? "active" : ""} onClick={() => setHealthFilter(filter)}>{filter === "all" ? "Усі" : filter === "blocked" ? "Блокери" : filter === "risk" ? "Ризик" : filter === "overdue" ? "Прострочені" : "Потрібне рішення"}</button>)}</div></div><div className="table-wrap"><table><thead><tr><th>Код</th><th>Завдання</th><th>Виконавець</th><th>Стан</th><th>Прогрес</th><th>Строк</th></tr></thead><tbody>{filtered.map((node) => <tr key={node.id}><td><button className="table-node-link" onClick={() => openWork(node.id)}>{node.code}</button></td><td><button className="table-title-link" onClick={() => openWork(node.id)}>{node.title}</button></td><td>{userById(node.assigneeId)?.name}</td><td><StatusBadge node={node} /></td><td>{node.progress}%</td><td>{dateLabel(node.plannedEnd)}</td></tr>)}</tbody></table></div></section>
  </>;
}

function AsanaSyncPanel({ payload, selected, asanaStatus, mutate, setNotice, compact = false }: { payload: PortalPayload; selected: WorkNode; asanaStatus: { configured: boolean; connected: boolean; connection?: Record<string, string> } | null; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; setNotice: Notify; compact?: boolean }) {
  const [draft, setDraft, clearDraft] = usePersistentDraft(`portal:asana-draft:${payload.currentUser.id}:${selected.id}`, { taskGid: selected.asana.taskGid || "", projectGid: selected.asana.projectGid || "", workspaceGid: selected.asana.workspaceGid || "", mode: "link" as "link" | "create" });
  const { taskGid, projectGid, workspaceGid, mode } = draft;
  const [asanaProjects, setAsanaProjects] = useState<Array<{ gid: string; name: string; workspace: string; workspaceGid: string }>>([]);
  const [asanaWorkspaces, setAsanaWorkspaces] = useState<Array<{ gid: string; name: string }>>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ gid: string; name: string; completed?: boolean; due_on?: string | null; permalink_url?: string; assignee?: { name: string } | null; projects?: Array<{ gid: string; name: string }>; workspace?: { name: string } }>>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const linked = Boolean(selected.asana.taskGid);
  useEffect(() => {
    if (!asanaStatus?.connected) return;
    fetch("/api/asana/projects", { cache: "no-store" })
      .then(async (response) => { const result = (await response.json()) as { workspaces?: Array<{ gid: string; name: string }>; projects?: Array<{ gid: string; name: string; workspace: string; workspaceGid: string }> }; if (!response.ok) throw new Error(); return result; })
      .then((result) => { setAsanaWorkspaces(result.workspaces || []); setAsanaProjects(result.projects || []); })
      .catch(() => { setAsanaWorkspaces([]); setAsanaProjects([]); });
  }, [asanaStatus?.connected]);
  const normalizeTaskGid = (value: string) => value.match(/\d{8,}/g)?.at(-1) || value.trim();
  const sync = async (action: "read" | "create" | "update", taskOverride = "") => {
    setBusy(true); setNotice("");
    try {
      const normalizedTaskGid = normalizeTaskGid(taskOverride || taskGid || selected.asana.taskGid);
      const resolvedProjectGid = action === "read" ? "" : projectGid || selected.asana.projectGid;
      const resolvedWorkspaceGid = workspaceGid || selected.asana.workspaceGid || (!resolvedProjectGid && asanaWorkspaces.length === 1 ? asanaWorkspaces[0].gid : "");
      const response = await fetch("/api/asana/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, nodeId: selected.id, taskGid: normalizedTaskGid, projectGid: resolvedProjectGid, workspaceGid: resolvedWorkspaceGid, title: selected.title, description: buildAsanaDescription(payload, selected), startOn: selected.plannedStart, dueOn: selected.plannedEnd, completed: selected.lifecycle === "completed" }) });
      const result = (await response.json()) as { error?: string; workspaceGid?: string; followerSync?: { added: number; skipped: string[] }; data?: { gid?: string; name?: string; notes?: string; due_on?: string | null; completed?: boolean; permalink_url?: string; modified_at?: string; assignee?: { email?: string; name?: string }; projects?: Array<{ gid: string; name: string }>; followers?: Array<{ gid: string; name: string; email?: string }> } };
      if (!response.ok) throw new Error(result.error || "Помилка Asana");
      const task = result.data || {};
      await mutate(`Синхронізовано ${selected.code} з Asana`, selected.id, (state) => {
        const node = state.nodes.find((item) => item.id === selected.id)!;
        if (action === "read") {
          if (node.asana.rules.title === "asana") node.title = task.name || node.title;
          if (node.asana.rules.dates === "asana") node.plannedEnd = task.due_on || node.plannedEnd;
          if (node.asana.rules.status === "asana") {
            if (task.completed) {
              const accepted = state.acceptances.some((item) => item.nodeId === node.id && item.status === "accepted");
              const submitted = state.acceptances.find((item) => item.nodeId === node.id && item.status === "submitted");
              if (accepted) node.lifecycle = "completed";
              else {
                node.lifecycle = "acceptance";
                node.progress = 99;
                node.actualEnd = "";
                if (!submitted) {
                  const acceptanceId = crypto.randomUUID();
                  const attempt = state.acceptances.filter((item) => item.nodeId === node.id).length + 1;
                  state.acceptances.unshift({ id: acceptanceId, nodeId: node.id, submittedBy: payload.currentUser.id, acceptorId: node.acceptorId, evidenceNote: "Asana підтверджує завершення пов’язаної задачі", status: "submitted", feedback: "", submittedAt: isoNow(), decidedAt: "", attempt });
                  state.discussions.unshift({ id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, recipientId: node.acceptorId, relatedType: "acceptance", relatedId: acceptanceId, text: "Asana підтвердила завершення пов’язаної задачі. Результат автоматично передано керівнику вищої ланки на приймання.", kind: "approval", createdAt: isoNow() });
                }
              }
            } else if (node.lifecycle === "completed" || node.lifecycle === "acceptance") {
              const pendingAcceptance = state.acceptances.find((item) => item.nodeId === node.id && item.status === "submitted");
              if (pendingAcceptance) { pendingAcceptance.status = "returned"; pendingAcceptance.feedback = "Пов’язану задачу повторно відкрито в Asana"; pendingAcceptance.decidedAt = isoNow(); }
              node.lifecycle = "in_progress";
              node.progress = Math.min(node.progress, 99);
              node.actualEnd = "";
            }
          }
          if (node.asana.rules.description === "asana" && task.notes) node.description = task.notes;
          if (node.asana.rules.assignee === "asana" && task.assignee?.email) node.assigneeId = state.users.find((candidate) => candidate.email.toLowerCase() === task.assignee?.email?.toLowerCase())?.id || node.assigneeId;
          node.updates = [{ id: crypto.randomUUID(), lifecycle: node.lifecycle, health: node.health, progress: node.progress, forecastEnd: node.forecastEnd, summary: task.notes?.trim() || `Фактичний стан отримано з Asana: ${task.name || node.title}`, nextAction: task.completed && node.lifecycle === "acceptance" ? "Керівнику вищої ланки прийняти результат у порталі" : task.completed ? "Результат прийнято" : "Продовжити виконання в Asana", createdAt: task.modified_at || isoNow(), createdBy: payload.currentUser.id, source: "asana" }, ...(node.updates || [])];
        }
        const resolvedGid = task?.gid || normalizedTaskGid;
        const resolvedUrl = task?.permalink_url || node.asana.taskUrl || (resolvedGid ? `https://app.asana.com/0/0/${resolvedGid}/f` : "");
        node.asana.taskGid = resolvedGid;
        node.asana.taskUrl = resolvedUrl;
        node.asana.projectGid = action === "read" ? task.projects?.[0]?.gid || "" : resolvedProjectGid;
        node.asana.workspaceGid = result.workspaceGid || resolvedWorkspaceGid;
        node.asana.lastSyncedAt = isoNow();
        node.asana.syncState = "linked";
        node.asana.remoteName = task.name || node.asana.remoteName || node.title;
        if (typeof task.completed === "boolean") node.asana.remoteCompleted = task.completed;
        node.asana.remoteDueOn = task.due_on || "";
        node.asana.remoteAssignee = task.assignee?.name || "";
        node.asana.remoteFollowerCount = Math.max(task.followers?.length || 0, result.followerSync?.added || 0);
        const otherPlaces = node.controlPlace.split("\n").filter((item) => item.trim() && !item.trim().startsWith("Asana ·"));
        node.controlPlace = [...otherPlaces, `Asana · ${resolvedUrl || resolvedGid}`].join("\n");
      });
      setDraft({ taskGid: task?.gid || normalizedTaskGid, projectGid: action === "read" ? task.projects?.[0]?.gid || "" : resolvedProjectGid, workspaceGid: result.workspaceGid || resolvedWorkspaceGid, mode: "link" });
      clearDraft();
      const followerNote = result.followerSync?.added ? ` · додано фоловерів: ${result.followerSync.added}` : "";
      setNotice(action === "create" ? `Задачу Asana створено й прив’язано${followerNote}` : action === "read" ? `Отримано актуальний стан Asana: ${task.completed ? "завершено" : "активне"}${followerNote}` : `Зміни передано в Asana${followerNote}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Помилка синхронізації", "error"); }
    finally { setBusy(false); }
  };
  const unlink = async () => {
    if (!window.confirm("Відв’язати задачу Asana від картки? Сама задача в Asana не видалятиметься.")) return;
    const ok = await mutate(`Відв’язано Asana від ${selected.code}`, selected.id, (state) => {
      const node = state.nodes.find((item) => item.id === selected.id)!;
      node.asana = defaultAsana();
      node.controlPlace = node.controlPlace.split("\n").filter((item) => !item.trim().startsWith("Asana ·")).join("\n");
    });
    if (ok) { setDraft({ taskGid: "", projectGid: "", workspaceGid: "", mode: "link" }); clearDraft(); }
  };
  const disconnectAccount = async () => {
    if (!window.confirm("Відключити ваш Asana-акаунт від порталу? Задачі в Asana та збережені посилання в картках не видалятимуться.")) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/asana/disconnect", { method: "POST" });
      const result = (await response.json()) as { error?: string; warning?: string };
      if (!response.ok) throw new Error(result.error || "Не вдалося відключити Asana-акаунт");
      setNotice(result.warning || "Asana-акаунт відключено");
      window.setTimeout(() => window.location.assign("/?view=settings&asana=disconnected"), 600);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не вдалося відключити Asana-акаунт", "error");
      setBusy(false);
    }
  };
  const effectiveWorkspaceGid = workspaceGid || (!projectGid && asanaWorkspaces.length === 1 ? asanaWorkspaces[0].gid : "");
  const destinationValue = projectGid ? `project:${projectGid}` : effectiveWorkspaceGid ? `workspace:${effectiveWorkspaceGid}` : "";
  const destinationField = asanaWorkspaces.length ? <select value={destinationValue} onChange={(event) => { const [kind, gid] = event.target.value.split(":"); const project = asanaProjects.find((item) => item.gid === gid); setDraft({ ...draft, projectGid: kind === "project" ? gid : "", workspaceGid: kind === "workspace" ? gid : project?.workspaceGid || "" }); }}><option value="">Оберіть місце створення</option>{asanaWorkspaces.map((workspace) => <option key={`workspace:${workspace.gid}`} value={`workspace:${workspace.gid}`}>Мої завдання · {workspace.name} (без проєкту)</option>)}{asanaProjects.map((project) => <option key={`project:${project.gid}`} value={`project:${project.gid}`}>{project.name} · {project.workspace}</option>)}</select> : <input value={workspaceGid} onChange={(event) => setDraft({ ...draft, projectGid: "", workspaceGid: event.target.value.trim() })} placeholder="GID робочого простору Asana" />;
  const searchTasks = async () => {
    if (searchQuery.trim().length < 2) return;
    setSearching(true); setSearchMessage(""); setNotice("");
    try {
      const response = await fetch(`/api/asana/tasks/search?q=${encodeURIComponent(searchQuery.trim())}`, { cache: "no-store" });
      const result = (await response.json()) as { error?: string; limitedSearch?: boolean; partial?: boolean; tasks?: typeof searchResults };
      if (!response.ok) throw new Error(result.error || "Не вдалося виконати пошук в Asana");
      const tasks = result.tasks || [];
      setSearchResults(tasks);
      setSearchMessage(tasks.length ? `${tasks.length} збігів${result.limitedSearch ? " · резервний пошук серед ваших задач" : ""}${result.partial ? " · частина робочих просторів недоступна" : ""}` : result.partial ? "У доступних робочих просторах збігів не знайдено" : "За цією назвою задач не знайдено");
    } catch (error) {
      setSearchResults([]);
      setSearchMessage(error instanceof Error ? error.message : "Не вдалося виконати пошук в Asana");
    } finally { setSearching(false); }
  };
  const syncPanel = <section id={`asana-link-${selected.id}`} className={compact ? "work-section asana-work" : "panel sync-workbench"}>
    <div className="panel-head"><div><span>Контрольне місце · Asana</span><h2>{linked ? "Задачу прив’язано" : "Прив’язати або створити задачу"}</h2></div><span className={`connection-state ${asanaStatus?.connected ? "connected" : ""}`}>{asanaStatus?.connected ? "Акаунт підключено" : "Акаунт не підключено"}</span></div>
    {!asanaStatus?.connected ? <div className="asana-empty"><p>Спочатку підключіть особистий Asana-акаунт у налаштуваннях порталу.</p></div> : linked ? <div className="asana-linked-card"><div><span>Пов’язана задача</span><strong>{selected.asana.remoteName || selected.asana.taskGid}</strong><div className="asana-remote-state"><b className={!selected.asana.lastSyncedAt ? "pending" : selected.asana.remoteCompleted ? "completed" : "active"}>{!selected.asana.lastSyncedAt ? "Стан не оновлено" : selected.asana.remoteCompleted ? "Завершено в Asana" : "Активне в Asana"}</b>{selected.asana.remoteDueOn && <small>Строк {dateLabel(selected.asana.remoteDueOn)}</small>}{selected.asana.remoteAssignee && <small>{selected.asana.remoteAssignee}</small>}{Boolean(selected.asana.remoteFollowerCount) && <small>Фоловерів: {selected.asana.remoteFollowerCount}</small>}</div><small>{selected.asana.lastSyncedAt ? `Оновлено ${new Date(selected.asana.lastSyncedAt).toLocaleString("uk-UA")}` : "Натисніть «Оновити з Asana», щоб отримати фактичний стан"}</small></div><div>{selected.asana.taskUrl && <a href={selected.asana.taskUrl} target="_blank" rel="noreferrer">Відкрити в Asana ↗</a>}<button disabled={busy} onClick={() => void sync("read")}>{busy ? "Оновлюємо…" : "Оновити з Asana"}</button><button disabled={busy} onClick={() => void sync("update")}>Передати зміни</button><button className="danger" disabled={busy} onClick={() => void unlink()}>Відв’язати</button></div></div> : <><div className="asana-mode-switch"><button className={mode === "link" ? "active" : ""} onClick={() => setDraft({ ...draft, mode: "link" })}>Прив’язати наявну</button><button className={mode === "create" ? "active" : ""} onClick={() => setDraft({ ...draft, mode: "create" })}>Створити нову</button></div>{mode === "link" ? <div className="asana-link-stack"><div className="asana-search-form"><label><span>Знайти завдання за назвою</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchTasks(); } }} placeholder="Введіть частину назви…" /></label><button className="primary" disabled={searching || searchQuery.trim().length < 2} onClick={() => void searchTasks()}>{searching ? "Шукаю…" : "Знайти"}</button></div>{searchMessage && <p className="asana-search-message">{searchMessage}</p>}{searchResults.length > 0 && <div className="asana-search-results">{searchResults.map((task) => <article key={task.gid}><div><strong>{task.name}</strong><span>{task.projects?.map((project) => project.name).join(", ") || task.workspace?.name || "Без проєкту"}</span><small>{task.assignee?.name || "Без виконавця"} · {task.completed ? "Завершено" : "Активне"} · {task.due_on ? `до ${dateLabel(task.due_on)}` : "без строку"}</small></div><button disabled={busy} onClick={() => void sync("read", task.gid)}>Прив’язати</button></article>)}</div>}<div className="asana-manual-divider"><span>або вставте посилання</span></div><div className="asana-link-form"><label><span>Посилання або GID задачі Asana</span><input value={taskGid} onChange={(event) => setDraft({ ...draft, taskGid: event.target.value })} placeholder="https://app.asana.com/… або GID" /></label><button className="primary" disabled={busy || !taskGid.trim()} onClick={() => void sync("read")}>Перевірити й прив’язати</button></div></div> : <div className="asana-create-form"><label><span>Місце створення в Asana</span>{destinationField}</label><div><span>Буде створено</span><strong>{selected.title}</strong><small>Учасники картки будуть додані фоловерами; без проєкту задача з’явиться у «Моїх завданнях» поточного Asana-користувача.</small></div><button className="primary" disabled={busy || (!projectGid && !effectiveWorkspaceGid)} onClick={() => void sync("create")}>Створити в Asana й прив’язати</button></div>}</>}
    {!compact && <div className="mapping-table"><div className="mapping-head"><span>Поле</span><span>Контрольне джерело</span></div>{Object.entries(selected.asana.rules).map(([field, rule]) => <div key={field}><span>{field === "title" ? "Назва" : field === "assignee" ? "Виконавець" : field === "dates" ? "Дати" : field === "status" ? "Стан" : "Опис"}</span><select value={rule} onChange={(event) => mutate(`Змінено правило синхронізації ${field}`, selected.id, (state) => { const node = state.nodes.find((item) => item.id === selected.id)!; node.asana.rules[field as keyof typeof node.asana.rules] = event.target.value as "portal" | "asana" | "manual"; })}><option value="portal">Портал</option><option value="asana">Asana</option><option value="manual">Ручне узгодження</option></select></div>)}</div>}
    <p className="sync-note">Після прив’язування Asana автоматично додається до «Контрольного місця». Портал зберігає управлінський результат, а Asana — фактичне виконання.</p>
  </section>;
  if (compact) return syncPanel;
  return <><div className="integration-grid single"><section className="panel integration-main"><div className="integration-brand"><div className="asana-logo">A</div><div><span>Asana</span><h2>{asanaStatus?.connected ? "Особистий акаунт підключено" : "Підключення очікується"}</h2><p>{asanaStatus?.configured ? "OAuth налаштовано. Після підключення можна створювати, отримувати та передавати зміни задач." : "Потрібні ключі Asana OAuth-застосунку для цього середовища."}</p></div><span className={`connection-state ${asanaStatus?.connected ? "connected" : ""}`}>{asanaStatus?.connected ? "Підключено" : "Не підключено"}</span></div>{asanaStatus?.connected ? <div className="connected-user"><div><strong>{String(asanaStatus.connection?.asana_user_name || payload.currentUser.name)}</strong><small>Зміни виконуватимуться від цього користувача. Відключення не видаляє задачі та зв’язки карток.</small></div><div className="asana-account-actions"><a href="/api/asana/start">Перепідключити акаунт</a><button className="danger" disabled={busy} onClick={() => void disconnectAccount()}>{busy ? "Відключаємо…" : "Відключити акаунт"}</button></div></div> : <a className={`button-link ${!asanaStatus?.configured ? "disabled" : ""}`} href={asanaStatus?.configured ? "/api/asana/start" : undefined}>Підключити мій Asana-акаунт</a>}</section></div>{syncPanel}</>;
}

function TelegramPanel({ payload, status, setStatus, notify }: { payload: PortalPayload; status: TelegramStatus | null; setStatus: (status: TelegramStatus) => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const [deepLink, setDeepLink] = useState("");
  const refresh = async () => { const response = await fetch("/api/telegram/status", { cache: "no-store" }); const result = (await response.json()) as TelegramStatus & { error?: string }; if (!response.ok) throw new Error(result.error || "Не вдалося перевірити Telegram"); setStatus(result); return result; };
  const action = async (path: string, body: Record<string, string>, success: string) => {
    setBusy(true); notify("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = (await response.json()) as { error?: string; deepLink?: string };
      if (!response.ok) throw new Error(result.error || "Telegram не підтвердив операцію");
      if (result.deepLink) setDeepLink(result.deepLink);
      await refresh();
      notify(success);
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Помилка Telegram", "error"); }
    finally { setBusy(false); }
  };
  const canSetup = ["owner", "admin"].includes(payload.currentUser.role);
  return <section className="panel telegram-panel"><div className="integration-brand"><div className="telegram-logo">✈</div><div><span>Telegram</span><h2>{status?.connected ? "Особистий чат підключено" : status?.configured ? "Бот готовий до прив’язки" : "Потрібне налаштування бота"}</h2><p>{status?.configured ? `Бот ${status.bot?.username ? `@${status.bot.username}` : "налаштований"} надсилає строки, блокери, рішення та запити приймання; контрольні дані залишаються в порталі.` : "Додайте токен від @BotFather і секрет webhook до середовища Cloudflare."}</p></div><span className={`connection-state ${status?.connected ? "connected" : ""}`}>{status?.connected ? "Підключено" : "Не підключено"}</span></div>{status?.webhook?.error && <p className="integration-error">Webhook: {status.webhook.error}</p>}<div className="telegram-actions">{status?.configured && canSetup && !status.webhook?.active && <button disabled={busy} onClick={() => void action("/api/telegram/setup", {}, "Telegram-webhook увімкнено")}>Увімкнути webhook</button>}{status?.configured && !status.connected && <button className="primary" disabled={busy || !status.webhook?.active} onClick={() => void action("/api/telegram/link", { action: "create_code" }, "Персональне посилання створено")}>Підключити Telegram</button>}{status?.connected && <><button disabled={busy} onClick={() => void action("/api/telegram/link", { action: "test" }, "Тестове повідомлення надіслано")}>Надіслати тест</button><button disabled={busy} onClick={() => void refresh().then(() => notify("Стан Telegram оновлено")).catch((cause) => notify(cause instanceof Error ? cause.message : "Помилка Telegram", "error"))}>Перевірити зв’язок</button><button className="danger" disabled={busy} onClick={() => void action("/api/telegram/link", { action: "unlink" }, "Telegram від’єднано")}>Від’єднати</button></>}</div>{deepLink && !status?.connected && <div className="telegram-link-box"><strong>Посилання діє 10 хвилин</strong><span>Відкрийте його зі свого Telegram і натисніть Start.</span><a href={deepLink} target="_blank" rel="noreferrer">Відкрити Telegram ↗</a></div>}</section>;
}

function AsanaAccountPanel({ payload, status, notify }: { payload: PortalPayload; status: { configured: boolean; connected: boolean; connection?: Record<string, string> } | null; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    if (!window.confirm("Відключити ваш Asana-акаунт від порталу? Задачі в Asana та збережені посилання в картках не видалятимуться.")) return;
    setBusy(true); notify("");
    try {
      const response = await fetch("/api/asana/disconnect", { method: "POST" });
      const result = (await response.json()) as { error?: string; warning?: string };
      if (!response.ok) throw new Error(result.error || "Не вдалося відключити Asana-акаунт");
      notify(result.warning || "Asana-акаунт відключено");
      window.setTimeout(() => window.location.assign("/?view=settings&asana=disconnected"), 600);
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Не вдалося відключити Asana-акаунт", "error"); setBusy(false); }
  };
  return <section className="panel integration-main"><div className="integration-brand"><div className="asana-logo">A</div><div><span>Asana</span><h2>{status?.connected ? "Особистий акаунт підключено" : "Підключення очікується"}</h2><p>{status?.configured ? "Тут керується лише особистий акаунт. Конкретні задачі прив’язуються в «Моїй роботі»." : "Потрібні ключі Asana OAuth-застосунку для цього середовища."}</p></div><span className={`connection-state ${status?.connected ? "connected" : ""}`}>{status?.connected ? "Підключено" : "Не підключено"}</span></div>{status?.connected ? <div className="connected-user"><div><strong>{String(status.connection?.asana_user_name || payload.currentUser.name)}</strong><small>Зміни в Asana виконуватимуться від цього користувача.</small></div><div className="asana-account-actions"><a href="/api/asana/start">Перепідключити акаунт</a><button className="danger" disabled={busy} onClick={() => void disconnect()}>{busy ? "Відключаємо…" : "Відключити акаунт"}</button></div></div> : <a className={`button-link ${!status?.configured ? "disabled" : ""}`} href={status?.configured ? "/api/asana/start" : undefined}>Підключити мій Asana-акаунт</a>}</section>;
}

function SettingsView({ payload, asanaStatus, telegramStatus, setTelegramStatus, setNotice, reload }: { payload: PortalPayload; asanaStatus: { configured: boolean; connected: boolean; connection?: Record<string, string> } | null; telegramStatus: TelegramStatus | null; setTelegramStatus: (status: TelegramStatus) => void; setNotice: Notify; reload: () => Promise<PortalPayload> }) {
  const administrator = ["owner", "admin"].includes(payload.currentUser.role);
  return <><PageIntro kicker="Налаштування" title="Акаунти, інтеграції та адміністрування" text="Особисті підключення доступні кожному користувачу; бібліотеки, права й журнал змін — лише адміністраторам." />
    <div className="settings-section-head"><div><span>Особисті інтеграції</span><h2>Asana та канали повідомлень</h2></div></div>
    <AsanaAccountPanel payload={payload} status={asanaStatus} notify={setNotice} />
    <TelegramPanel payload={payload} status={telegramStatus} setStatus={setTelegramStatus} notify={setNotice} />
    {administrator && <><div className="settings-section-head"><span>Бібліотеки</span><h2>Учасники порталу та відповідальні</h2><p>Записи цієї бібліотеки використовуються в усіх полях координатора, виконавця, приймання та ескалації.</p></div><UserLibraryEditor payload={payload} reload={reload} setNotice={setNotice} /><div className="settings-layout settings-bottom"><section className="panel"><div className="panel-head"><div><span>Розвиток</span><h2>Повторювані цикли</h2></div><span className="planned-label">Архітектуру закладено</span></div><p className="panel-copy">Кожна ціль, цикл, підцикл або завдання має правило повторення, інтервал і наступну дату. Автоматичне створення екземплярів буде ввімкнено після першого реального повторюваного циклу.</p><div className="future-box"><strong>Майбутній сценарій</strong><span>Шаблон → дата запуску → новий екземпляр → зв’язок із попереднім періодом → окрема звітність.</span></div></section><section className="panel"><div className="panel-head"><div><span>Довідники наступної черги</span><h2>Кероване розширення</h2></div></div><div className="library-roadmap"><span>Ролі та повноваження</span><span>Типи результатів</span><span>Причини блокерів</span><span>Шаблони координації</span><span>Джерела даних</span></div></section></div><section className="panel audit-panel"><div className="panel-head"><div><span>Контроль</span><h2>Журнал змін</h2></div><span>{payload.audit.length} записів</span></div><div className="audit-list">{payload.audit.slice(0, 30).map((entry) => <div key={entry.id}><time>{new Date(entry.at).toLocaleString("uk-UA")}</time><strong>{entry.action}</strong><span>{entry.by}</span><code>{entry.entityId}</code></div>)}</div></section></>}
  </>;
}

function generatePassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%_-+"];
  const alphabet = groups.join("");
  const values = crypto.getRandomValues(new Uint32Array(20));
  const characters = groups.map((group, index) => group[values[index] % group.length]);
  for (let index = groups.length; index < values.length; index += 1) characters.push(alphabet[values[index] % alphabet.length]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = values[index] % (index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join("");
}

function UserLibraryEditor({ payload, reload, setNotice }: { payload: PortalPayload; reload: () => Promise<PortalPayload>; setNotice: Notify }) {
  const [newUser, setNewUser] = useState(() => {
    let saved: { name?: string; email?: string; role?: PortalUser["role"] } = {};
    if (typeof window !== "undefined") try { saved = JSON.parse(window.localStorage.getItem(`portal:contact-draft:${payload.currentUser.id}`) || "{}"); } catch { /* ignore invalid local draft */ }
    return { name: saved.name || "", email: saved.email || "", role: saved.role || "executor" as PortalUser["role"], password: generatePassword() };
  });
  const [issued, setIssued] = useState<{ name: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const editable = ["owner", "admin"].includes(payload.currentUser.role);
  const roleOptions = Object.entries(roleLabels).filter(([value]) => value !== "owner" && (payload.currentUser.role === "owner" || value !== "admin"));
  useEffect(() => {
    try { window.localStorage.setItem(`portal:contact-draft:${payload.currentUser.id}`, JSON.stringify({ name: newUser.name, email: newUser.email, role: newUser.role })); } catch { /* local draft is best-effort */ }
  }, [newUser.email, newUser.name, newUser.role, payload.currentUser.id]);
  const manage = async (body: Record<string, unknown>) => {
    setBusy(true);
    setNotice("");
    try {
      let revision = payload.revision;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, expectedRevision: revision }) });
        const result = (await response.json()) as { error?: string };
        if (response.ok) {
          await reload();
          setNotice(attempt ? "Контакт додано після автоматичного оновлення даних" : "Доступ користувача оновлено");
          return true;
        }
        if (response.status === 409 && attempt === 0) {
          revision = (await reload()).revision;
          continue;
        }
        throw new Error(result.error || "Не вдалося оновити доступ");
      }
      return false;
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Не вдалося оновити доступ", "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const next = { name: !newUser.name.trim() ? "Вкажіть ім’я та прізвище." : "", email: !newUser.email.trim() ? "Вкажіть корпоративну адресу." : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newUser.email.trim()) ? "Перевірте формат адреси." : "", password: !newUser.password ? "Згенеруйте тимчасовий пароль." : "" };
    const active = Object.fromEntries(Object.entries(next).filter(([, value]) => value));
    if (Object.keys(active).length) { setErrors(active); setNotice("Не вдалося створити доступ: перевірте виділені поля.", "error"); focusFirstError(); return; }
    const password = newUser.password;
    const ok = await manage({ action: "create", ...newUser });
    if (ok) {
      setIssued({ name: newUser.name.trim(), password });
      setNewUser({ name: "", email: "", role: "executor", password: generatePassword() });
      try { window.localStorage.removeItem(`portal:contact-draft:${payload.currentUser.id}`); } catch { /* local draft is best-effort */ }
      setErrors({});
    }
  };
  const resetPassword = async (user: PortalUser) => {
    const password = generatePassword();
    const ok = await manage({ action: "reset_password", userId: user.id, password });
    if (ok) setIssued({ name: user.name, password });
  };
  const canEdit = (user: PortalUser) => editable && user.role !== "owner" && (payload.currentUser.role === "owner" || user.role !== "admin");
  return <section className="panel user-library"><div className="panel-head"><div><span>Користувачі та доступ</span><h2>Редактор учасників</h2></div><div className="library-head-meta"><small>{editable ? "Створення доступу, ролей і паролів" : "Перегляд без редагування"}</small><b className="count">{payload.users.filter((user) => user.active).length}</b></div></div>{issued && <div className="password-reveal"><div><span>Новий пароль для {issued.name}</span><strong>{issued.password}</strong><small>Скопіюйте зараз: після закриття цей пароль більше не показуватиметься.</small></div><button onClick={() => void navigator.clipboard.writeText(issued.password)}>Копіювати</button><button className="secondary" onClick={() => setIssued(null)}>Закрити</button></div>}<div className="library-add"><Field label="Ім’я та прізвище" required error={errors.name} hint="Повне ім’я, яке відображатиметься у відповідальних і звітах."><input disabled={!editable || busy} aria-invalid={Boolean(errors.name)} value={newUser.name} onChange={(event) => { setNewUser({ ...newUser, name: event.target.value }); setErrors((current) => ({ ...current, name: "" })); }} placeholder="Наприклад: Ірина Коваль" /></Field><Field label="Корпоративна адреса" required error={errors.email} hint="Ця адреса буде логіном користувача."><input disabled={!editable || busy} aria-invalid={Boolean(errors.email)} type="email" value={newUser.email} onChange={(event) => { setNewUser({ ...newUser, email: event.target.value }); setErrors((current) => ({ ...current, email: "" })); }} placeholder="name@pravdop.com" /></Field><Field label="Роль доступу" required hint="Роль визначає можливість перегляду, виконання, координації або адміністрування."><select disabled={!editable || busy} value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value as PortalUser["role"] })}>{roleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Тимчасовий пароль" required error={errors.password} hint="Передайте пароль користувачу захищеним каналом; після входу його слід змінити."><div className="generated-password"><input readOnly value={newUser.password} aria-label="Згенерований пароль" aria-invalid={Boolean(errors.password)} /><button type="button" disabled={!editable || busy} onClick={() => { setNewUser({ ...newUser, password: generatePassword() }); setErrors((current) => ({ ...current, password: "" })); }}>↻</button></div></Field><button className="primary" disabled={!editable || busy} onClick={() => void add()}>+ Створити доступ</button></div><div className="user-library-table">{payload.users.map((user) => { const rowEditable = canEdit(user); return <div key={user.id}><UserAvatar user={user} /><label><span>Ім’я <i className="required-mark">*</i></span><input disabled={!rowEditable || busy} defaultValue={user.name} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== user.name) void manage({ action: "update", userId: user.id, name: value, email: user.email, role: user.role }); }} /></label><label><span>Логін <i className="required-mark">*</i></span><input disabled={!rowEditable || busy} type="email" defaultValue={user.email} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== user.email) void manage({ action: "update", userId: user.id, name: user.name, email: value, role: user.role }); }} /></label><label><span>Роль доступу <i className="required-mark">*</i></span><select disabled={!rowEditable || busy} value={user.role} onChange={(event) => void manage({ action: "update", userId: user.id, name: user.name, email: user.email, role: event.target.value })}>{!roleOptions.some(([value]) => value === user.role) && <option value={user.role}>{roleLabels[user.role]}</option>}{roleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button disabled={!rowEditable || busy} className="password-reset-button" onClick={() => void resetPassword(user)}>Новий пароль</button><button disabled={!rowEditable || busy || user.id === payload.currentUser.id} className={user.active ? "user-active-button" : "user-inactive-button"} onClick={() => void manage({ action: "toggle_active", userId: user.id })}>{user.active ? "Активний" : "Вимкнено"}</button></div>; })}</div></section>;
}

function ModalShell({ title, subtitle, close, children, footer }: { title: string; subtitle: string; close: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const titleId = useId();
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId}><header><div><span>{subtitle}</span><h2 id={titleId}>{title}</h2></div><button onClick={close} aria-label="Закрити">×</button></header><div className="modal-body">{children}</div><footer>{footer}</footer></section></div>;
}

function Field({ label, children, wide = false, required = false, hint, example, error }: { label: string; children: React.ReactNode; wide?: boolean; required?: boolean; hint?: string; example?: string; error?: string }) {
  return <label className={`${wide ? "wide " : ""}${error ? "field-error" : ""}`}>
    <span className="field-label"><span>{label}{required && <i className="required-mark" aria-hidden="true"> *</i>}</span>{(hint || example) && <span className="field-help" role="button" tabIndex={0} aria-label={`Підказка до поля «${label}»`}><i aria-hidden="true">і</i><span className="field-help-popover" role="tooltip">{hint && <span>{hint}</span>}{example && <span><b>Приклад:</b> {example}</span>}</span></span>}</span>
    {children}
    {error && <small className="field-error-text" role="alert">{error}</small>}
  </label>;
}

function focusFirstError() {
  window.requestAnimationFrame(() => (document.querySelector(".field-error input, .field-error textarea, .field-error select, .input-error") as HTMLElement | null)?.focus());
}

function NodeModal({ node, setNode, nodes, users, errors, clearError, close, save }: { node: WorkNode; setNode: (node: WorkNode) => void; nodes: WorkNode[]; users: PortalUser[]; errors: NodeErrors; clearError: (key: keyof WorkNode) => void; close: () => void; save: () => void }) {
  const update = <K extends keyof WorkNode>(key: K, value: WorkNode[K]) => { clearError(key); setNode({ ...node, [key]: value }); };
  const allowedParents = allowedParentKinds(node.kind);
  const validParents = allowedParents.length ? nodes.filter((item) => allowedParents.includes(item.kind) && !item.archived && item.id !== node.id) : [];
  const path = nodePath(nodes.filter((item) => item.id !== node.id).concat(node), node);
  const hasChildren = nodes.some((item) => item.parentId === node.id && !item.archived);
  const controlPlaces = node.controlPlace ? node.controlPlace.split("\n") : [""];
  const setControlPlace = (index: number, value: string) => update("controlPlace", controlPlaces.map((item, itemIndex) => itemIndex === index ? value : item).join("\n"));
  return <ModalShell title={`${node.code} · ${node.title || "Новий об’єкт"}`} subtitle={kindLabels[node.kind]} close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={save}>Зберегти</button></>}>
    <div className="node-path" aria-label="Шлях у дереві">{path.map((item, index) => <span key={item.id}><b>{item.code || "…"}</b><small>{item.title || kindLabels[item.kind]}</small>{index < path.length - 1 && <i>/</i>}</span>)}</div>
    <div className="form-grid">
      <Field label="Код" required error={errors.code} hint="Стабільний код показує місце в дереві й не повинен повторюватися." example="S1, P1, P1.1 або P1.1.3"><input value={node.code} aria-invalid={Boolean(errors.code)} onChange={(event) => update("code", event.target.value)} placeholder="Наприклад: P1.1.3" /></Field>
      <Field label="Тип" required hint="Рівень визначає батьківський рівень, права координації та спосіб розрахунку стану."><select value={node.kind} onChange={(event) => { const kind = event.target.value as NodeKind; const parentKinds = allowedParentKinds(kind); const currentParent = node.parentId ? nodes.find((item) => item.id === node.parentId) : undefined; const parentId = currentParent && parentKinds.includes(currentParent.kind) ? currentParent.id : parentKinds.length ? nodes.find((item) => parentKinds.includes(item.kind) && !item.archived)?.id || null : null; setNode({ ...node, kind, parentId }); }}><option value="goal">Стратегічна ціль</option><option value="cycle">Управлінський цикл</option><option value="subcycle">Підцикл</option><option value="task">Завдання</option></select></Field>
      {allowedParents.length > 0 && <Field wide required error={errors.parentId} label={`Батьківський рівень · ${parentKindsLabel(allowedParents)}`} hint={node.kind === "task" ? "Завдання можна включити безпосередньо в управлінський цикл або в його підцикл." : "Оберіть безпосередній вищий рівень, до результату якого належить цей об’єкт."}><select value={node.parentId || ""} aria-invalid={Boolean(errors.parentId)} onChange={(event) => update("parentId", event.target.value)}><option value="">Оберіть батьківський рівень</option>{validParents.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>)}</select></Field>}
      <Field wide label="Назва" required error={errors.title} hint="Коротко назвіть результат або предмет управління — без опису процесу." example="Поновлення старих послуг"><input value={node.title} aria-invalid={Boolean(errors.title)} onChange={(event) => update("title", event.target.value)} placeholder="Наприклад: Поновлення старих послуг" /></Field>
      <Field wide label="Опис" hint="Дайте контекст: навіщо цей об’єкт існує, що охоплює та які має межі."><textarea value={node.description} onChange={(event) => update("description", event.target.value)} placeholder="Короткий контекст, межі та призначення" /></Field>
      <Field wide label="Готовий результат" required error={errors.result} hint="Опишіть стан, який можна перевірити й прийняти. Уникайте формулювань «працювати над» або «займатися»." example="Сторінка послуги оновлена, погоджена та опублікована."><textarea value={node.result} aria-invalid={Boolean(errors.result)} onChange={(event) => update("result", event.target.value)} placeholder="Наприклад: матеріал погоджено й опубліковано" /></Field>
      <Field wide label="Що не є результатом" hint="Зафіксуйте дії або проміжні стани, які самі по собі не означають завершення." example="Проведена зустріч без погодженого матеріалу."><textarea value={node.nonResult} onChange={(event) => update("nonResult", event.target.value)} placeholder="Наприклад: лише обговорення без погодженого результату" /></Field>
      <Field wide label="Критерій приймання" hint="Умови, за якими приймальник однозначно підтвердить результат." example="Текст погоджений власником, усі посилання працюють, сторінка відкрита для клієнтів."><textarea value={node.acceptanceCriteria} onChange={(event) => update("acceptanceCriteria", event.target.value)} placeholder="Що саме перевіряє особа, яка приймає результат" /></Field>
      <Field label="Координатор" required error={errors.ownerId} hint="Організовує виконання, контролює відхилення та забезпечує отримання результату."><select value={node.ownerId} aria-invalid={Boolean(errors.ownerId)} onChange={(event) => update("ownerId", event.target.value)}>{users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
      <Field label="Виконавець" required error={errors.assigneeId} hint="Людина, яка виконує завдання або координує нижчі рівні."><select value={node.assigneeId} aria-invalid={Boolean(errors.assigneeId)} onChange={(event) => update("assigneeId", event.target.value)}>{users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
      <Field label="Керівник вищої ланки" required error={errors.acceptorId} hint="Контролює об’єкт на вищому рівні та приймає результат або повертає його на доопрацювання."><select value={node.acceptorId} aria-invalid={Boolean(errors.acceptorId)} onChange={(event) => update("acceptorId", event.target.value)}>{users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
      <Field label="Пріоритет" required hint="Визначає порядок управлінської уваги, якщо одночасно конкурують кілька робіт."><select value={node.priority} onChange={(event) => update("priority", event.target.value as WorkNode["priority"])}><option value="critical">Критичний</option><option value="high">Високий</option><option value="normal">Нормальний</option><option value="low">Низький</option></select></Field>
      {node.kind !== "task" && <Field label="Статус" required error={errors.lifecycle} hint={hasChildren ? "Автоматичний режим розраховує статус із нижчих рівнів. Оберіть конкретний статус, якщо потрібне явне управлінське переведення." : "Оберіть фактичний стан цілі, циклу або підциклу. Після появи нижчих рівнів можна перейти на автоматичний розрахунок."}><select value={node.lifecycleOverride || (hasChildren ? "automatic" : node.lifecycle)} aria-invalid={Boolean(errors.lifecycle)} onChange={(event) => { clearError("lifecycle"); const value = event.target.value; if (value === "automatic") setNode({ ...node, lifecycleOverride: undefined }); else { const lifecycle = value as LifecycleStatus; setNode({ ...node, lifecycle, lifecycleOverride: lifecycle, progress: lifecycle === "completed" ? 100 : node.progress, actualEnd: lifecycle === "completed" ? isoNow().slice(0, 10) : node.actualEnd }); } }}>{hasChildren && <option value="automatic">Автоматично з нижчих рівнів</option>}{Object.entries(lifecycleLabels).map(([value, label]) => <option key={value} value={value} disabled={value === "completed" && Boolean(completionBlockReason(nodes, node))}>{label}</option>)}</select></Field>}
      <Field wide label="Учасники / фоловери" hint="Особи, які бачать зміни картки та отримують сповіщення. Після зв’язування з Asana вони додаються фоловерами задачі за корпоративною адресою."><div className="participant-picker">{users.filter((user) => user.active).map((user) => <label key={user.id}><input type="checkbox" checked={node.participantIds.includes(user.id)} onChange={(event) => update("participantIds", event.target.checked ? [...node.participantIds, user.id] : node.participantIds.filter((id) => id !== user.id))} /><span>{user.name}</span></label>)}</div></Field>
      <Field label="Початок" hint="Планова дата, якщо її можна визначити наперед."><input type="date" value={node.plannedStart} onChange={(event) => update("plannedStart", event.target.value)} /></Field>
      <Field label="Завершення" hint="Погоджений плановий строк готового результату."><input type="date" value={node.plannedEnd} onChange={(event) => update("plannedEnd", event.target.value)} /></Field>
      <Field label="Прогноз" hint="Поточна реалістична дата завершення; може відрізнятися від плану."><input type="date" value={node.forecastEnd} onChange={(event) => update("forecastEnd", event.target.value)} /></Field>
      <Field label="Прогрес, %" required hint={node.kind === "task" ? "Частка фактично отриманого результату, а не витраченого часу." : "Для цілі, циклу й підциклу прогрес автоматично розраховується з нижчих рівнів."}><input type="number" min="0" max="100" value={node.progress} disabled={node.kind !== "task"} onChange={(event) => update("progress", Number(event.target.value))} /></Field>
      <Field label="Спосіб початку" required hint="Визначає, коли робота може стартувати: разом із батьківським рівнем, за датою, після залежності або після звільнення ресурсу."><select value={node.startMode} onChange={(event) => update("startMode", event.target.value as StartMode)}>{Object.entries(startLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      {node.kind === "cycle" && <><Field label="Перша координація" hint="Дата першого зведеного перегляду циклу; від неї календар розраховує наступні події."><input type="date" value={node.coordinationStartDate || ""} onChange={(event) => { const value = event.target.value; setNode({ ...node, coordinationStartDate: value, coordinationWeekday: value ? new Date(`${value}T12:00:00`).getDay() : node.coordinationWeekday }); }} /></Field><Field label="День координації" hint="Виберіть день тижня. Якщо першу дату вже задано, вона пересунеться вперед до обраного дня."><select value={node.coordinationWeekday ?? 1} onChange={(event) => { const weekday = Number(event.target.value); setNode({ ...node, coordinationWeekday: weekday, coordinationStartDate: alignDateToWeekday(node.coordinationStartDate || "", weekday) }); }}>{weekdayLabels.map((label, index) => <option key={label} value={index}>{label}</option>)}</select></Field><Field label="Періодичність, днів" hint="Кількість календарних днів між координаціями циклу." example="7 — щотижня; 14 — раз на два тижні"><input type="number" min="1" max="365" value={node.coordinationIntervalDays || 7} onChange={(event) => update("coordinationIntervalDays", Math.max(1, Number(event.target.value) || 1))} /></Field></>}
      <Field wide label="Повноваження" hint="Які рішення відповідальний може приймати самостійно та що повинен погоджувати."><textarea value={node.authority} onChange={(event) => update("authority", event.target.value)} placeholder="Самостійні рішення, межі та ескалація" /></Field>
      <Field wide label="Ресурс" hint="Люди, бюджет, матеріали, доступи або час, потрібні для результату."><textarea value={node.resource} onChange={(event) => update("resource", event.target.value)} placeholder="Наприклад: 8 годин дизайнера та доступ до CMS" /></Field>
      <Field wide label="Контрольне місце" hint="Система або сторінка, де перевіряється фактичне виконання. Кнопка «+» додає ще одне контрольне місце." example="Asana, CRM, сторінка сайту або реєстр договорів"><div className="multi-value-field">{controlPlaces.map((place, index) => <div key={index}><input value={place} onChange={(event) => setControlPlace(index, event.target.value)} placeholder="Наприклад: Asana або сторінка сайту" />{index === controlPlaces.length - 1 && <button type="button" onClick={() => update("controlPlace", `${node.controlPlace}${node.controlPlace ? "\n" : ""}`)} aria-label="Додати контрольне місце">+</button>}</div>)}</div></Field>
      <Field label="Доступ" required hint="Визначає, хто бачить об’єкт та його робочі дані."><select value={node.visibility} onChange={(event) => update("visibility", event.target.value as WorkNode["visibility"])}><option value="company">Уся компанія</option><option value="participants">Лише учасники</option></select></Field>
      <Field label="Повторення" hint="Для циклів і завдань, які повторюються за однаковим правилом."><select value={node.recurrence.enabled ? node.recurrence.frequency : "off"} onChange={(event) => setNode({ ...node, recurrence: { ...node.recurrence, enabled: event.target.value !== "off", frequency: event.target.value === "off" ? "monthly" : event.target.value as WorkNode["recurrence"]["frequency"] } })}><option value="off">Немає</option><option value="weekly">Щотижня</option><option value="monthly">Щомісяця</option><option value="quarterly">Щокварталу</option><option value="yearly">Щороку</option></select></Field>
    </div>
  </ModalShell>;
}

function BlockerModal({ node, users, currentUserId, notify, close, save }: { node: WorkNode; users: PortalUser[]; currentUserId: string; notify: Notify; close: () => void; save: (blocker: Blocker) => void }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:blocker-draft:${currentUserId}:${node.id}`, { title: "", facts: "", cause: "", actionsTaken: "", ownerId: node.assigneeId, escalationToId: node.ownerId, recommendation: "", impact: "", decisionDue: node.plannedEnd });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (key: string, value: string) => { setErrors((current) => ({ ...current, [key]: "" })); setForm({ ...form, [key]: value }); };
  const submit = () => {
    const next = { title: !form.title.trim() ? "Вкажіть, що саме зупинило виконання." : "", facts: !form.facts.trim() ? "Зафіксуйте перевірювані факти без припущень." : "", ownerId: !form.ownerId ? "Оберіть відповідального за усунення." : "", escalationToId: !form.escalationToId ? "Оберіть адресата ескалації." : "", decisionDue: !form.decisionDue ? "Вкажіть строк реакції." : "" };
    const active = Object.fromEntries(Object.entries(next).filter(([, value]) => value));
    if (Object.keys(active).length) { setErrors(active); notify("Не вдалося зберегти блокер: перевірте виділені поля.", "error"); focusFirstError(); return; }
    clearDraft(); save({ id: crypto.randomUUID(), nodeId: node.id, ...form, status: "open", approvalStatus: "pending", approvalComment: "", approvedBy: "", approvedAt: "", createdAt: isoNow(), resolvedAt: "" });
  };
  return <ModalShell title={`Блокер для ${node.code}`} subtitle="Раннє реагування" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Зафіксувати блокер</button></>}><div className="form-grid"><Field wide label="Що заблоковано" required error={errors.title} hint="Назвіть конкретний результат або наступну дію, які зараз неможливі." example="Неможливо опублікувати сторінку через відсутність погодженого тексту."><input value={form.title} aria-invalid={Boolean(errors.title)} onChange={(event) => update("title", event.target.value)} placeholder="Наприклад: публікацію зупинено" /></Field><Field wide label="Факти" required error={errors.facts} hint="Лише спостережувані факти: що відсутнє, коли виявлено, яка дія не виконується."><textarea value={form.facts} aria-invalid={Boolean(errors.facts)} onChange={(event) => update("facts", event.target.value)} placeholder="Наприклад: станом на 14.08 погодження власника не отримано" /></Field><Field wide label="Причина" hint="Відома першопричина. Якщо її ще не встановлено, так і зазначте."><textarea value={form.cause} onChange={(event) => update("cause", event.target.value)} placeholder="Наприклад: не визначено; потрібна перевірка" /></Field><Field wide label="Уже виконані дії" hint="Що вже зроблено для усунення перешкоди та який був результат."><textarea value={form.actionsTaken} onChange={(event) => update("actionsTaken", event.target.value)} placeholder="Наприклад: надіслано нагадування 13.08, відповіді немає" /></Field><Field label="Відповідальний" required error={errors.ownerId} hint="Людина, яка організовує усунення блокера."><select value={form.ownerId} aria-invalid={Boolean(errors.ownerId)} onChange={(event) => update("ownerId", event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field><Field label="Ескалація до" required error={errors.escalationToId} hint="Кому передається питання, якщо відповідальний не може усунути блокер самостійно."><select value={form.escalationToId} aria-invalid={Boolean(errors.escalationToId)} onChange={(event) => update("escalationToId", event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field><Field wide label="Рекомендація" hint="Конкретне рішення, яке пропонує відповідальний."><textarea value={form.recommendation} onChange={(event) => update("recommendation", event.target.value)} placeholder="Наприклад: погодити варіант А або призначити іншого редактора" /></Field><Field wide label="Наслідок без рішення" hint="Що станеться зі строком, результатом або пов’язаними завданнями без реакції."><textarea value={form.impact} onChange={(event) => update("impact", event.target.value)} placeholder="Наприклад: публікація зміститься щонайменше на 3 дні" /></Field><Field label="Рішення потрібне до" required error={errors.decisionDue} hint="Гранична дата реакції до настання суттєвого наслідку."><input type="date" value={form.decisionDue} aria-invalid={Boolean(errors.decisionDue)} onChange={(event) => update("decisionDue", event.target.value)} /></Field></div></ModalShell>;
}

function DecisionModal({ node, users, currentUserId, notify, close, save }: { node: WorkNode; users: PortalUser[]; currentUserId: string; notify: Notify; close: () => void; save: (decision: Decision) => void }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:decision-draft:${currentUserId}:${node.id}`, { question: "", options: "", recommendation: "", decisionOwnerId: node.ownerId, dueDate: node.plannedEnd });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (key: keyof typeof form, value: string) => { setErrors((current) => ({ ...current, [key]: "" })); setForm({ ...form, [key]: value }); };
  const submit = () => { const next = { question: !form.question.trim() ? "Сформулюйте одне рішення, яке потрібно прийняти." : "", decisionOwnerId: !form.decisionOwnerId ? "Оберіть уповноважену особу." : "", dueDate: !form.dueDate ? "Вкажіть строк рішення." : "" }; const active = Object.fromEntries(Object.entries(next).filter(([, value]) => value)); if (Object.keys(active).length) { setErrors(active); notify("Не вдалося надіслати запит рішення: перевірте виділені поля.", "error"); focusFirstError(); return; } clearDraft(); save({ id: crypto.randomUUID(), nodeId: node.id, ...form, resolution: "", status: "requested", createdAt: isoNow(), decidedAt: "" }); };
  return <ModalShell title={`Запит рішення · ${node.code}`} subtitle="Управлінська ескалація" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Надіслати запит</button></>}><div className="form-grid"><Field wide label="Питання" required error={errors.question} hint="Одне чітке питання, яке потребує управлінського вибору." example="Чи погоджуємо публікацію варіанта А без нового відео?"><textarea value={form.question} aria-invalid={Boolean(errors.question)} onChange={(event) => update("question", event.target.value)} placeholder="Наприклад: який із двох варіантів затверджуємо?" /></Field><Field wide label="Варіанти" hint="Перелічіть реальні альтернативи та короткий наслідок кожної."><textarea value={form.options} onChange={(event) => update("options", event.target.value)} placeholder="Варіант А — ...; варіант Б — ..." /></Field><Field wide label="Рекомендація" hint="Який варіант ви рекомендуєте та чому."><textarea value={form.recommendation} onChange={(event) => update("recommendation", event.target.value)} placeholder="Рекомендую варіант А, тому що…" /></Field><Field label="Хто вирішує" required error={errors.decisionOwnerId} hint="Особа з повноваженням прийняти це рішення."><select value={form.decisionOwnerId} aria-invalid={Boolean(errors.decisionOwnerId)} onChange={(event) => update("decisionOwnerId", event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field><Field label="Строк рішення" required error={errors.dueDate} hint="Дата, до якої рішення ще дозволяє зберегти план або мінімізувати наслідки."><input type="date" value={form.dueDate} aria-invalid={Boolean(errors.dueDate)} onChange={(event) => update("dueDate", event.target.value)} /></Field></div></ModalShell>;
}

function CoordinationModal({ node, payload, currentUserId, notify, close, save }: { node: WorkNode; payload: PortalPayload; currentUserId: string; notify: Notify; close: () => void; save: (snapshot: CoordinationSnapshot) => void }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:coordination-draft:${currentUserId}:${node.id}`, { summary: "", agreements: "" });
  const { summary, agreements } = form;
  const [summaryError, setSummaryError] = useState("");
  const branch = descendants(payload.nodes.filter((item) => !item.archived), node.id);
  const tasks = branch.filter((item) => item.kind === "task");
  const subcycles = branch.filter((item) => item.kind === "subcycle");
  const branchIds = new Set(branch.map((item) => item.id));
  const path = nodePath(payload.nodes, node);
  const submit = () => { if (!summary.trim()) { setSummaryError("Зафіксуйте висновок координації та потрібну управлінську увагу."); notify("Не вдалося зберегти координацію: заповніть виділене поле.", "error"); focusFirstError(); return; } clearDraft(); save({ id: crypto.randomUUID(), subcycleId: node.id, cycleId: node.id, title: `${node.code}: ${node.title}`, path: path.map((item) => `${item.code}: ${item.title}`).join(" / "), date: isoNow().slice(0, 10), facilitatorId: payload.currentUser.id, summary, agreements, taskState: tasks.map((task) => ({ nodeId: task.id, lifecycle: task.lifecycle, health: task.health, plannedEnd: task.plannedEnd, progress: task.progress })), blockerIds: payload.blockers.filter((item) => item.status === "open" && branchIds.has(item.nodeId)).map((item) => item.id), decisionIds: payload.decisions.filter((item) => item.status === "requested" && branchIds.has(item.nodeId)).map((item) => item.id), createdAt: isoNow() }); };
  return <ModalShell title={`Координація циклу ${node.code}: ${node.title}`} subtitle="Зведений знімок усіх завдань циклу" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Зберегти координацію циклу</button></>}><div className="coordination-path" aria-label="Шлях координації">{path.map((item, index) => <span key={item.id}><b>{item.code}</b><small>{item.title}</small>{index < path.length - 1 && <i>›</i>}</span>)}</div><div className="snapshot-preview"><strong>До знімка циклу потраплять</strong><span>{subcycles.length} підциклів</span><span>{tasks.length} завдань</span><span>{tasks.filter((task) => task.lifecycle === "completed").length} завершено</span><span>{tasks.filter((task) => task.health === "blocked").length} заблоковано</span><span>{tasks.filter((task) => task.lifecycle === "acceptance").length} на прийманні</span></div><div className="form-grid"><Field wide label="Зведений висновок за циклом" required error={summaryError} hint="Підсумуйте результат усіх завдань циклу: що завершено, де відхилення, які підцикли потребують уваги, які рішення необхідні." example="7 із 10 завдань завершено; підцикл P1.2 має блокер; потрібне рішення щодо бюджету до 20.08."><textarea value={summary} aria-invalid={Boolean(summaryError)} onChange={(event) => { setForm({ ...form, summary: event.target.value }); setSummaryError(""); }} placeholder="Зведений стан завдань, підциклів, строків і відхилень" /></Field><Field wide label="Погоджені дії та рішення" hint="Фіксуйте домовленість як: хто — що робить — до якого строку." example="Валентина до 18.08 готує макет; Володимир того ж дня погоджує."><textarea value={agreements} onChange={(event) => setForm({ ...form, agreements: event.target.value })} placeholder="Наприклад: відповідальний — дія — строк" /></Field></div></ModalShell>;
}

function DependencyModal({ node, payload, currentUserId, notify, close, save }: { node: WorkNode; payload: PortalPayload; currentUserId: string; notify: Notify; close: () => void; save: (dependency: Dependency) => void }) {
  const reaches = (from: string, target: string) => {
    const visited = new Set<string>(); const queue = [from];
    while (queue.length) { const current = queue.shift()!; if (current === target) return true; if (visited.has(current)) continue; visited.add(current); queue.push(...payload.dependencies.filter((item) => item.predecessorId === current).map((item) => item.successorId)); }
    return false;
  };
  const candidates = payload.nodes.filter((item) => item.kind === "task" && item.id !== node.id && !item.archived && !reaches(node.id, item.id) && !payload.dependencies.some((dependency) => dependency.predecessorId === item.id && dependency.successorId === node.id));
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:dependency-draft:${currentUserId}:${node.id}`, { predecessorId: candidates[0]?.id || "", type: "finish_start" as Dependency["type"] });
  const { predecessorId, type } = form;
  const [error, setError] = useState("");
  const submit = () => { if (!predecessorId) { setError("Немає вибраного допустимого попереднього завдання."); notify("Не вдалося додати залежність: перевірте виділене поле.", "error"); focusFirstError(); return; } clearDraft(); save({ id: crypto.randomUUID(), predecessorId, successorId: node.id, type, createdAt: isoNow() }); };
  return <ModalShell title={`Залежність для ${node.code}`} subtitle="Мережа виконання" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Додати залежність</button></>}><div className="form-grid"><Field wide label="Попереднє завдання" required error={error} hint="Завдання, від події якого залежить початок або завершення поточного завдання."><select value={predecessorId} aria-invalid={Boolean(error)} onChange={(event) => { setForm({ ...form, predecessorId: event.target.value }); setError(""); }}>{candidates.length ? candidates.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>) : <option value="">Немає допустимих завдань</option>}</select></Field><Field wide label="Тип залежності" required hint="Визначає, яка подія попередника дозволяє або обмежує подію поточного завдання."><select value={type} onChange={(event) => setForm({ ...form, type: event.target.value as Dependency["type"] })}><option value="finish_start">Завершення → початок</option><option value="start_start">Початок → початок</option><option value="finish_finish">Завершення → завершення</option><option value="start_finish">Початок → завершення</option></select></Field></div></ModalShell>;
}

function EvidenceModal({ node, currentUser, notify, close, save }: { node: WorkNode; currentUser: PortalUser; notify: Notify; close: () => void; save: (evidence: Evidence) => void }) {
  const [draft, setDraft, clearDraft] = usePersistentDraft(`portal:evidence-draft:${currentUser.id}:${node.id}`, { kind: "link" as Evidence["kind"], label: "", value: "" });
  const { kind, label, value } = draft;
  const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async () => {
    const next = { label: !label.trim() ? "Дайте доказу зрозумілу назву." : "", value: kind === "file" ? (!file ? "Оберіть файл для завантаження." : "") : (!value.trim() ? (kind === "link" ? "Вставте повне посилання." : "Запишіть зміст доказу.") : "") };
    const active = Object.fromEntries(Object.entries(next).filter(([, entry]) => entry));
    if (Object.keys(active).length) { setErrors(active); notify("Не вдалося додати доказ: перевірте виділені поля.", "error"); focusFirstError(); return; }
    setBusy(true);
    try {
      let finalValue = value;
      if (kind === "file" && file) {
        const form = new FormData(); form.set("nodeId", node.id); form.set("file", file);
        const response = await fetch("/api/files", { method: "POST", body: form });
        const result = (await response.json()) as { url?: string; name?: string; error?: string };
        if (!response.ok || !result.url) throw new Error(result.error || "Не вдалося завантажити файл");
        finalValue = result.url;
      }
      clearDraft(); save({ id: crypto.randomUUID(), kind, label: label.trim(), value: finalValue, createdAt: isoNow(), createdBy: currentUser.id });
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Не вдалося додати доказ", "error"); }
    finally { setBusy(false); }
  };
  return <ModalShell title={`Доказ виконання · ${node.code}`} subtitle="Перевірюваний результат" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "Завантажуємо…" : "Додати доказ"}</button></>}><div className="form-grid"><Field label="Тип" required hint="Посилання — на зовнішній результат; нотатка — коротка зафіксована перевірка; файл — матеріал, завантажений до порталу."><select value={kind} onChange={(event) => { setDraft({ ...draft, kind: event.target.value as Evidence["kind"] }); setErrors({}); }}><option value="link">Посилання</option><option value="note">Нотатка</option><option value="file">Файл</option></select></Field><Field wide label="Назва доказу" required error={errors.label} hint="Назва має пояснювати, що підтверджує доказ." example="Опублікована сторінка послуги"><input value={label} aria-invalid={Boolean(errors.label)} onChange={(event) => { setDraft({ ...draft, label: event.target.value }); setErrors((current) => ({ ...current, label: "" })); }} placeholder="Наприклад: погоджений макет сторінки" /></Field>{kind === "file" ? <Field wide label="Файл до 20 МБ" required error={errors.value} hint="Файл потрібно вибрати повторно після оновлення сторінки; браузер не дозволяє зберігати його локально."><input type="file" aria-invalid={Boolean(errors.value)} onChange={(event) => { setFile(event.target.files?.[0] || null); setErrors((current) => ({ ...current, value: "" })); }} /></Field> : <Field wide required error={errors.value} label={kind === "link" ? "Посилання" : "Зміст нотатки"} hint={kind === "link" ? "Вставте повне посилання на доступний результат." : "Стисло зафіксуйте факт, який підтверджує виконання."}>{kind === "link" ? <input value={value} aria-invalid={Boolean(errors.value)} onChange={(event) => { setDraft({ ...draft, value: event.target.value }); setErrors((current) => ({ ...current, value: "" })); }} placeholder="https://…" /> : <textarea value={value} aria-invalid={Boolean(errors.value)} onChange={(event) => { setDraft({ ...draft, value: event.target.value }); setErrors((current) => ({ ...current, value: "" })); }} placeholder="Наприклад: власник підтвердив приймання 14.08" />}</Field>}</div></ModalShell>;
}
