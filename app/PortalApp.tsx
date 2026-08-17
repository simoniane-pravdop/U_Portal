"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  PortalState,
  PortalUser,
  StartMode,
  WorkUpdate,
  WorkNode,
} from "./types";

type View = "dashboard" | "tree" | "my" | "coordination" | "settings";
type Modal = "node" | "blocker" | "decision" | "coordination" | "dependency" | "evidence" | null;
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
const startLabels: Record<StartMode, string> = {
  with_parent: "Разом із батьківським рівнем",
  manual_capacity: "Після звільнення ресурсу",
  fixed_date: "У визначену дату",
  after_dependency: "Після залежності",
};
const roleLabels: Record<string, string> = {
  owner: "Власник порталу",
  admin: "Адміністратор",
  goal_owner: "Власник цілі",
  cycle_owner: "Власник циклу",
  coordinator: "Координатор",
  executor: "Виконавець",
  viewer: "Спостерігач",
};
const nav: Array<{ id: View; label: string; hint: string; mark: string }> = [
  { id: "dashboard", label: "Дашборд", hint: "Результати й відхилення", mark: "01" },
  { id: "tree", label: "Дерево цілей", hint: "Цикли та завдання", mark: "02" },
  { id: "my", label: "Моя робота", hint: "Виконання й звіти", mark: "03" },
  { id: "coordination", label: "Координація", hint: "Управління підциклами", mark: "04" },
  { id: "settings", label: "Налаштування", hint: "Бібліотеки й інтеграції", mark: "05" },
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

function defaultAsana() {
  return {
    taskGid: "",
    taskUrl: "",
    projectGid: "",
    sectionGid: "",
    lastSyncedAt: null,
    syncState: "not_linked" as const,
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
    coordinationCadence: kind === "subcycle" ? "Щотижня" : "",
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
    if (meaningful.length && meaningful.every((child) => child.lifecycle === "completed")) parent.lifecycle = "completed";
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
  return <div className="login-screen"><form className="login-card" onSubmit={(event) => void submit(event)} noValidate><div className="loading-mark">УП</div><span>Захищений доступ</span><h1>Управлінський портал</h1><p>Увійдіть за корпоративною адресою, для якої адміністратор надав доступ.</p><label className={error ? "has-error" : ""}><b>Корпоративна адреса <i className="required-mark">*</i></b><input type="email" autoComplete="username" value={email} onChange={(event) => { setEmail(event.target.value); setError(""); }} placeholder="Наприклад: name@pravdop.com" required aria-invalid={Boolean(error)} /></label><label className={error ? "has-error" : ""}><b>Пароль <i className="required-mark">*</i></b><input type="password" autoComplete="current-password" value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} placeholder="Введіть виданий адміністратором пароль" required aria-invalid={Boolean(error)} /></label>{error && <div className="login-error" role="alert">{error}</div>}<button type="submit" disabled={busy}>{busy ? "Перевіряємо…" : "Увійти"}</button><small><i className="required-mark">*</i> — обов’язкові поля. Права доступу та паролі користувачів керуються в налаштуваннях порталу.</small></form></div>;
}

export function PortalApp() {
  const [payload, setPayload] = useState<PortalPayload | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [selectedId, setSelectedId] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [draftNode, setDraftNode] = useState<WorkNode | null>(null);
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<"all" | HealthStatus | "overdue" | "decision">("all");
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

  const setNotice = useCallback<Notify>((value, tone = "success") => {
    setNoticeState(value);
    setNoticeTone(tone);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(""), noticeTone === "error" ? 7000 : 3500);
    return () => window.clearTimeout(timer);
  }, [notice, noticeTone]);

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
      .then(() => {
        const requestedView = new URLSearchParams(window.location.search).get("view") as View | null;
        if (requestedView && nav.some((item) => item.id === requestedView)) setView(requestedView);
      })
      .catch((error) => setLoadError(error.message));
  }, [load]);

  useEffect(() => { payloadRef.current = payload; }, [payload]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => { draftNodeRef.current = draftNode; }, [draftNode]);

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

  if (!payload || !data) return loadError ? <LoginScreen initialError={loadError.startsWith("Потрібен вхід") ? "" : loadError} /> : <div className="loading-screen"><div className="loading-mark">УП</div><strong>Готуємо управлінський портал…</strong></div>;

  const userById = (id: string) => payload.users.find((user) => user.id === id);
  const selected = payload.nodes.find((node) => node.id === selectedId && !node.archived) || payload.nodes.find((node) => !node.archived);
  const canManage = ["owner", "admin", "goal_owner", "cycle_owner", "coordinator"].includes(payload.currentUser.role);
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
    if (!draftNode.ownerId) errors.ownerId = "Оберіть власника результату.";
    if (!draftNode.assigneeId) errors.assigneeId = "Оберіть виконавця або координатора.";
    if (!draftNode.acceptorId) errors.acceptorId = "Оберіть того, хто приймає результат.";
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

  const submitAcceptance = (node: WorkNode) => mutate(`Передано ${node.code} на приймання`, node.id, (state) => {
    const prior = state.acceptances.filter((item) => item.nodeId === node.id).length;
    state.acceptances.unshift({
      id: crypto.randomUUID(), nodeId: node.id, submittedBy: payload.currentUser.id, acceptorId: node.acceptorId,
      evidenceNote: node.evidence.map((item) => item.label).join(", "), status: "submitted", feedback: "",
      submittedAt: isoNow(), decidedAt: "", attempt: prior + 1,
    });
    const target = state.nodes.find((item) => item.id === node.id)!;
    target.lifecycle = "acceptance";
    state.discussions.unshift({ id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, text: `Результат передано на погодження: ${payload.users.find((user) => user.id === node.acceptorId)?.name || "приймальнику"}.`, kind: "approval", createdAt: isoNow() });
  });

  const resolveAcceptance = (acceptance: Acceptance, accepted: boolean) => mutate(
    accepted ? "Результат прийнято" : "Результат повернуто на доопрацювання",
    acceptance.nodeId,
    (state) => {
      const item = state.acceptances.find((candidate) => candidate.id === acceptance.id)!;
      item.status = accepted ? "accepted" : "returned";
      item.decidedAt = isoNow();
      item.feedback = accepted ? "Результат відповідає критерію приймання" : "Потрібне доопрацювання за коментарем відповідального";
      const node = state.nodes.find((candidate) => candidate.id === acceptance.nodeId)!;
      node.lifecycle = accepted ? "completed" : "in_progress";
      if (accepted) {
        node.progress = 100;
        node.actualEnd = isoNow().slice(0, 10);
        node.health = "normal";
      }
      state.discussions.unshift({ id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, text: accepted ? "Результат погоджено й прийнято." : "Результат повернуто на доопрацювання.", kind: "approval", createdAt: isoNow() });
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
    <main className="app-shell">
      {notice && <div className={`global-notice ${noticeTone}`} role={noticeTone === "error" ? "alert" : "status"} aria-live={noticeTone === "error" ? "assertive" : "polite"}><span>{noticeTone === "error" ? "!" : "✓"}</span><strong>{notice}</strong><button type="button" onClick={() => setNoticeState("")} aria-label="Закрити повідомлення">×</button></div>}
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">УП</div>
          <div><strong>Управлінський портал</strong><span>{payload.settings.organizationName}</span></div>
        </div>
        <nav aria-label="Основна навігація">
          {nav.map((item) => (
            <button key={item.id} className={view === item.id ? "active" : ""} title={item.label} onClick={() => setView(item.id)}>
              <span className="nav-mark">{item.mark}</span><span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`system-dot ${payload.storage}`} />
          <div><strong>{payload.storage === "database" ? "Дані зберігаються" : "Тестовий режим"}</strong><small>Редакція {payload.revision}</small></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-context">
            <span>{nav.find((item) => item.id === view)?.mark}</span>
            <div><strong>{nav.find((item) => item.id === view)?.label}</strong><small>Єдине дерево відповідальності й результатів</small></div>
          </div>
          <div className="topbar-actions">
            {saving && <span className="saving">Зберігаємо…</span>}
            <div className="user-switch">
              <UserAvatar user={payload.currentUser} compact />
              <div><strong>{payload.currentUser.name}</strong><small>{roleLabels[payload.currentUser.role]}</small></div>
              <button type="button" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }}>Вийти</button>
            </div>
          </div>
        </header>

        <div className="content">
          {view === "dashboard" && <DashboardView data={data} payload={payload} userById={userById} healthFilter={healthFilter} setHealthFilter={setHealthFilter} mutate={mutate} select={(id) => { setSelectedId(id); setView("tree"); }} />}
          {view === "tree" && (
            <TreeView
              payload={payload} selected={selected} selectedId={selectedId} setSelectedId={setSelectedId}
              search={search} setSearch={setSearch} userById={userById} canManage={canManage}
              locks={locks}
              openCreateKind={openCreateKind} openEdit={openEdit}
              openWork={(node) => { setSelectedId(node.id); setView("my"); }}
              mutate={mutate} completeNode={completeNode}
            />
          )}
          {view === "my" && <MyWork key={selected?.id || "empty"} payload={payload} selected={selected} selectedId={selectedId} setSelectedId={setSelectedId} userById={userById} canManage={canManage} saveWorkUpdate={saveWorkUpdate} submitAcceptance={submitAcceptance} resolveAcceptance={resolveAcceptance} completeNode={completeNode} setModal={setModal} asanaStatus={asanaStatus} mutate={mutate} setNotice={setNotice} openTree={(id) => { setSelectedId(id); setView("tree"); }} />}
          {view === "coordination" && <CoordinationView payload={payload} userById={userById} select={(id) => { setSelectedId(id); setView("tree"); }} open={(node) => { setSelectedId(node.id); setModal("coordination"); }} />}
          {view === "settings" && <SettingsView payload={payload} selected={selected} setSelectedId={setSelectedId} asanaStatus={asanaStatus} telegramStatus={telegramStatus} setTelegramStatus={setTelegramStatus} mutate={mutate} setNotice={setNotice} reload={load} />}
        </div>
      </section>

      {modal === "node" && draftNode && <NodeModal node={draftNode} setNode={setDraftNode} nodes={payload.nodes} users={payload.users} errors={nodeErrors} clearError={(key) => setNodeErrors((current) => ({ ...current, [key]: undefined }))} close={closeNodeEditor} save={saveNode} />}
      {modal === "blocker" && selected && <BlockerModal node={selected} users={payload.users} notify={setNotice} close={() => setModal(null)} save={async (blocker) => { const ok = await mutate(`Додано блокер до ${selected.code}`, selected.id, (state) => { state.blockers.unshift(blocker); const target = state.nodes.find((node) => node.id === selected.id)!; target.health = "blocked"; target.decisionRequired = true; }); if (ok) setModal(null); }} />}
      {modal === "decision" && selected && <DecisionModal node={selected} users={payload.users} notify={setNotice} close={() => setModal(null)} save={async (decision) => { const ok = await mutate(`Запитано рішення для ${selected.code}`, selected.id, (state) => { state.decisions.unshift(decision); state.nodes.find((node) => node.id === selected.id)!.decisionRequired = true; }); if (ok) setModal(null); }} />}
      {modal === "coordination" && selected && ["cycle", "subcycle"].includes(selected.kind) && <CoordinationModal node={selected} payload={payload} notify={setNotice} close={() => setModal(null)} save={async (snapshot) => { const ok = await mutate(`Зафіксовано координацію ${selected.code}`, selected.id, (state) => state.coordinations.unshift(snapshot)); if (ok) setModal(null); }} />}
      {modal === "dependency" && selected?.kind === "task" && <DependencyModal node={selected} payload={payload} notify={setNotice} close={() => setModal(null)} save={async (dependency) => { const ok = await mutate(`Додано залежність для ${selected.code}`, selected.id, (state) => state.dependencies.push(dependency)); if (ok) setModal(null); }} />}
      {modal === "evidence" && selected && <EvidenceModal node={selected} currentUser={payload.currentUser} notify={setNotice} close={() => setModal(null)} save={async (evidence) => { const ok = await mutate(`Додано доказ до ${selected.code}`, selected.id, (state) => state.nodes.find((node) => node.id === selected.id)!.evidence.push(evidence)); if (ok) setModal(null); }} />}
    </main>
  );
}

type ComputedData = { activeNodes: WorkNode[]; tasks: WorkNode[]; goals: WorkNode[]; subcycles: WorkNode[]; overdue: WorkNode[]; blocked: WorkNode[]; decisions: Decision[]; completed: WorkNode[]; onTimeRate: number; firstPassRate: number; returnedCount: number };

function PageIntro({ kicker, title, text, actions }: { kicker: string; title: string; text: string; actions?: React.ReactNode }) {
  return <div className="page-intro"><div><span>{kicker}</span><h1>{title}</h1><p>{text}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>;
}

function DashboardView({ data, payload, userById, healthFilter, setHealthFilter, mutate, select }: { data: ComputedData; payload: PortalPayload; userById: (id: string) => PortalUser | undefined; healthFilter: "all" | HealthStatus | "overdue" | "decision"; setHealthFilter: (value: "all" | HealthStatus | "overdue" | "decision") => void; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; select: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [ownerId, setOwnerId] = useState("all");
  const firstGoal = data.goals[0];
  const coordination = data.subcycles[0];
  const coordinationTasks = coordination ? payload.nodes.filter((node) => node.parentId === coordination.id && !node.archived) : [];
  const openRegister = (filter: "all" | HealthStatus | "overdue" | "decision") => { setHealthFilter(filter); window.requestAnimationFrame(() => document.getElementById("control-register")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  return <>
    <PageIntro kicker="Єдиний керівницький екран" title="Результати, стани та управлінська реакція" text="Цілі, строки, блокери, рішення і навантаження зведені в одному дашборді. Детальна робота виконується в розділі «Моя робота»." actions={<div className="page-filter-bar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Пошук завдання…" /><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="all">Усі відповідальні</option>{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><select value={healthFilter} onChange={(event) => openRegister(event.target.value as typeof healthFilter)}><option value="all">Усі стани</option><option value="blocked">Блокери</option><option value="risk">Ризик</option><option value="overdue">Прострочені</option><option value="decision">Потрібне рішення</option></select></div>} />
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
          {[...data.blocked, ...data.overdue.filter((node) => node.health !== "blocked")].slice(0, 6).map((node) => <button key={node.id} onClick={() => select(node.id)}><span className={`signal ${node.health}`} /><div><strong>{node.code} · {node.title}</strong><small>{node.health === "blocked" ? "Заблоковано" : `Строк ${dateLabel(node.plannedEnd)}`}</small></div><b>→</b></button>)}
          {!data.blocked.length && !data.overdue.length && <p className="empty-state">Критичних відхилень немає.</p>}
        </div>
      </section>
    </div>
    <section className="panel cadence-strip">
      <div><span>Найближча координація</span><strong>{coordination ? `${coordination.code} · ${coordination.title}` : "Підциклів ще немає"}</strong><small>{coordination ? "Одиниця координації — підцикл, а проблеми піднімаються з конкретних завдань." : "Після створення підциклу тут з’явиться його поточний стан."}</small></div>
      <div className="cadence-stat"><strong>{coordinationTasks.filter((node) => node.lifecycle === "in_progress").length}</strong><span>у роботі</span></div>
      <div className="cadence-stat red"><strong>{coordinationTasks.filter((node) => payload.blockers.some((item) => item.nodeId === node.id && item.status === "open")).length}</strong><span>блокер</span></div>
      <button disabled={!coordination} onClick={() => coordination && select(coordination.id)}>Перейти до підциклу</button>
    </section>
    <div className="dashboard-section-head"><div><span>Відхилення</span><h2>Блокери та відкриті рішення</h2></div><p>Адресат, строк реакції, рекомендація та наслідок без рішення.</p></div>
    <RiskRegisters payload={payload} userById={userById} mutate={mutate} select={select} />
    <div className="dashboard-section-head"><div><span>Аналітика</span><h2>Виконання, строки й навантаження</h2></div><p>Показники для управлінських рішень, а не підрахунку активності.</p></div>
    <ReportAnalytics payload={payload} data={data} userById={userById} healthFilter={healthFilter} setHealthFilter={setHealthFilter} query={query} ownerId={ownerId} select={select} />
  </>;
}

function TreeView(props: {
  payload: PortalPayload; selected?: WorkNode; selectedId: string; setSelectedId: (id: string) => void; search: string; setSearch: (value: string) => void;
  userById: (id: string) => PortalUser | undefined; canManage: boolean; locks: EditingLock[]; openCreateKind: (kind: NodeKind, context?: WorkNode) => void; openEdit: (node: WorkNode) => Promise<void>;
  openWork: (node: WorkNode) => void; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; completeNode: (node: WorkNode) => Promise<boolean>;
}) {
  const { payload, selected, selectedId, setSelectedId, search, setSearch, userById, canManage, locks, openCreateKind, openEdit, openWork, mutate, completeNode } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(payload.nodes.filter((node) => node.kind !== "task").map((node) => node.id)));
  const [detailTab, setDetailTab] = useState<"passport" | "structure" | "history">("passport");
  const [treeCompact, setTreeCompact] = useState(false);
  const [mobilePane, setMobilePane] = useState<"tree" | "card">("tree");
  const [kindFilter, setKindFilter] = useState<"all" | NodeKind>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState<"all" | "active" | "risk" | "completed">("all");
  const active = payload.nodes.filter((node) => !node.archived);
  const query = search.trim().toLowerCase();
  const visibleIds = new Set<string>();
  for (const node of active) {
    const matchesQuery = !query || `${node.code} ${node.title} ${node.result}`.toLowerCase().includes(query);
    const matchesKind = kindFilter === "all" || node.kind === kindFilter;
    const matchesOwner = ownerFilter === "all" || node.ownerId === ownerFilter || node.assigneeId === ownerFilter;
    const matchesState = stateFilter === "all" || stateFilter === "active" && !["completed", "cancelled"].includes(node.lifecycle) || stateFilter === "risk" && node.health !== "normal" || stateFilter === "completed" && node.lifecycle === "completed";
    if (matchesQuery && matchesKind && matchesOwner && matchesState) {
      visibleIds.add(node.id);
      let parentId = node.parentId;
      while (parentId) {
        visibleIds.add(parentId);
        parentId = payload.nodes.find((item) => item.id === parentId)?.parentId || null;
      }
    }
  }
  const filtered = active.filter((node) => visibleIds.has(node.id));
  const predecessors = selected ? payload.dependencies.filter((item) => item.successorId === selected.id).map((item) => payload.nodes.find((node) => node.id === item.predecessorId)).filter(Boolean) as WorkNode[] : [];
  const children = selected ? payload.nodes.filter((node) => node.parentId === selected.id && !node.archived) : [];
  const canEditSelected = Boolean(selected && (canManage || selected.ownerId === payload.currentUser.id));

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

  return <>
    <PageIntro kicker="Структура управління" title="Дерево цілей, циклів і завдань" text="Тут створюється структура та зберігаються паспорти. Виконання й звіти ведуться у «Моїй роботі»." actions={canManage && <details className="create-uo-menu"><summary>+ Створити</summary><div>{(["goal", "cycle", "subcycle", "task"] as NodeKind[]).map((kind) => <button key={kind} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreateKind(kind, selected); }}><span>{kind === "goal" ? "S" : kind === "cycle" ? "P" : kind === "subcycle" ? "P.x" : "✓"}</span>{kindLabels[kind]}</button>)}</div></details>} />
    <div className="mobile-tree-switch" role="tablist"><button className={mobilePane === "tree" ? "active" : ""} onClick={() => setMobilePane("tree")}>Дерево</button><button disabled={!selected} className={mobilePane === "card" ? "active" : ""} onClick={() => setMobilePane("card")}>{selected ? `Картка ${selected.code}` : "Картка"}</button></div>
    <div className={`tree-workbench ${treeCompact ? "compact-tree" : ""} mobile-pane-${mobilePane}`}>
      <aside className="tree-catalog">
        <div className="catalog-head">{!treeCompact && <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Пошук у дереві…" />}<span>{filtered.length}</span><button className="tree-compact-toggle" onClick={() => setTreeCompact((value) => !value)} title={treeCompact ? "Розгорнути дерево" : "Згорнути дерево до кодів"} aria-label={treeCompact ? "Розгорнути дерево" : "Згорнути дерево до кодів"}>{treeCompact ? "→" : "К"}</button></div>
        {!treeCompact && <div className="compact-filters"><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as "all" | NodeKind)}><option value="all">Усі рівні</option><option value="goal">Цілі</option><option value="cycle">Цикли</option><option value="subcycle">Підцикли</option><option value="task">Завдання</option></select><select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option value="all">Усі відповідальні</option>{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">Усі стани</option><option value="active">Активні</option><option value="risk">Ризик / блокер</option><option value="completed">Завершені</option></select></div>}
        <div className="tree-scroll">{renderBranch(null)}{!filtered.length && <p className="empty-state padded">Дерево порожнє. Створіть першу стратегічну ціль.</p>}</div>
      </aside>
      {selected ? <section className="node-detail">
        <header className="node-detail-head">
          <div><span>{kindLabels[selected.kind]} · {selected.code}</span><h2>{selected.title}</h2><p>{selected.result}</p></div>
          <div className="node-head-actions"><ProgressRing value={selected.progress} />{canEditSelected && <button className="secondary" onClick={() => void openEdit(selected)}>Редагувати паспорт</button>}{canEditSelected && selected.lifecycle !== "completed" && <button className="positive" onClick={() => void completeNode(selected)}>Завершити</button>}<button className="primary work-link" onClick={() => openWork(selected)}>Відкрити робочу картку →</button></div>
        </header>
        <div className="status-line"><StatusBadge node={selected} />{selected.decisionRequired && <span className="decision-badge">Потрібне рішення</span>}<span>{lifecycleLabels[selected.lifecycle]}</span><span>Оновлено {new Date(selected.updatedAt).toLocaleString("uk-UA")}</span></div>
        <div className="detail-tabs" role="tablist">{(["passport", "structure", "history"] as const).map((tab) => <button key={tab} className={`${detailTab === tab ? "active" : ""} ${tab === "history" ? "history-tab" : ""}`} onClick={() => setDetailTab(tab)}>{tab === "passport" ? "Паспорт" : tab === "structure" ? "Структура і зв’язки" : `Історія · ${payload.audit.filter((entry) => entry.entityId === selected.id).length + (selected.updates || []).length}`}</button>)}</div>
        {detailTab === "passport" && <><div className="detail-grid"><article><span>Власник результату</span><div className="person-line"><UserAvatar user={userById(selected.ownerId)} /><div><strong>{userById(selected.ownerId)?.name}</strong><small>Несе відповідальність за результат</small></div></div></article><article><span>Виконавець / координатор</span><div className="person-line"><UserAvatar user={userById(selected.assigneeId)} /><div><strong>{userById(selected.assigneeId)?.name}</strong><small>{selected.kind === "task" ? "Виконує завдання" : "Координує нижчі рівні"}</small></div></div></article><article><span>Плановий строк</span><strong>{dateLabel(selected.plannedEnd)}</strong><small>{daysUntil(selected.plannedEnd) !== null ? `${daysUntil(selected.plannedEnd)} дн. до строку` : "Дата не встановлена"}</small></article><article><span>Фактичний стан</span><strong>{lifecycleLabels[selected.lifecycle]} · {selected.progress}%</strong><small>{selected.kind === "task" ? "Оновлюється у робочій картці" : "Розраховано з нижчих рівнів"}</small></article></div><div className="detail-columns info-only"><div><section className="detail-section"><h3>Результат і межі</h3><dl><dt>Опис</dt><dd>{selected.description || "Не визначено"}</dd><dt>Готовий результат</dt><dd>{selected.result || "Не визначено"}</dd><dt>Що не є результатом</dt><dd>{selected.nonResult || "Не визначено"}</dd><dt>Критерій приймання</dt><dd>{selected.acceptanceCriteria || "Не визначено"}</dd></dl></section><section className="detail-section"><h3>Умови виконання</h3><dl><dt>Спосіб початку</dt><dd>{startLabels[selected.startMode]}</dd><dt>Повноваження</dt><dd>{selected.authority || "Не визначено"}</dd><dt>Ресурс</dt><dd>{selected.resource || "Не визначено"}</dd><dt>Контрольне місце</dt><dd>{selected.controlPlace || "Не визначено"}</dd></dl></section></div><aside><section className="side-section explainer"><b>Режим перегляду</b><h3>Дерево не є робочим журналом</h3><p>Тут перевіряють місце в структурі, межі, відповідального та агрегований стан. Виконання, звіт і Asana відкриваються в робочій картці.</p><button className="primary" onClick={() => openWork(selected)}>Перейти до роботи</button></section><section className="side-section"><div className="side-head"><h3>Докази результату</h3><span>{selected.evidence.length}</span></div>{selected.evidence.map((item) => <a className="evidence-row" key={item.id} href={item.kind === "note" ? undefined : item.value} target="_blank" rel="noreferrer"><span>{item.kind === "file" ? "Файл" : item.kind === "link" ? "Посилання" : "Нотатка"}</span><strong>{item.label}</strong></a>)}{!selected.evidence.length && <p className="empty-state">Докази ще не додано.</p>}</section></aside></div></>}
        {detailTab === "structure" && <div className="detail-tab-body"><section className="detail-section"><h3>Батьківський рівень</h3>{selected.parentId ? <button className="parent-link" onClick={() => setSelectedId(selected.parentId!)}>{payload.nodes.find((node) => node.id === selected.parentId)?.code} · {payload.nodes.find((node) => node.id === selected.parentId)?.title}</button> : <p className="empty-state">Верхній рівень дерева.</p>}</section><section className="detail-section"><h3>Нижчий рівень</h3>{children.length > 0 ? <div className="child-list">{children.map((node) => <button key={node.id} onClick={() => setSelectedId(node.id)}><span>{node.code}</span><strong>{node.title}</strong><StatusBadge node={node} /></button>)}</div> : <p className="empty-state">Нижчих рівнів немає.</p>}</section><section className="detail-section"><h3>Залежності виконання</h3>{predecessors.length ? predecessors.map((node) => <button className="parent-link" key={node.id} onClick={() => setSelectedId(node.id)}>Після {node.code} · {node.title}</button>) : <p className="empty-state">Окремих попередників немає.</p>}</section></div>}
        {detailTab === "history" && <div className="detail-tab-body"><section className="detail-section"><h3>Робочі звіти</h3><div className="update-history">{(selected.updates || []).map((item) => <article key={item.id}><time>{new Date(item.createdAt).toLocaleString("uk-UA")}</time><strong>{lifecycleLabels[item.lifecycle]} · {item.progress}%</strong><p>{item.summary}</p><small>Наступна дія: {item.nextAction || "Не вказано"}</small></article>)}{!(selected.updates || []).length && <p className="empty-state">Робочих звітів ще немає.</p>}</div></section><section className="detail-section"><h3>Журнал змін</h3><div className="update-history">{payload.audit.filter((entry) => entry.entityId === selected.id).map((entry) => <article key={entry.id}><time>{new Date(entry.at).toLocaleString("uk-UA")}</time><strong>{entry.action}</strong><small>{entry.by}</small></article>)}</div></section></div>}
      </section> : <section className="node-detail empty-tree"><div><span>Початок роботи</span><h2>Створіть першу стратегічну ціль</h2><p>Після цього до неї можна буде послідовно додати управлінські цикли, підцикли та конкретні завдання.</p>{canManage && <button className="primary" onClick={() => openCreateKind("goal")}>+ Створити стратегічну ціль</button>}</div></section>}
    </div>
  </>;
}

function MyWork({ payload, selected, selectedId, setSelectedId, userById, canManage, saveWorkUpdate, submitAcceptance, resolveAcceptance, completeNode, setModal, asanaStatus, mutate, setNotice, openTree }: { payload: PortalPayload; selected?: WorkNode; selectedId: string; setSelectedId: (id: string) => void; userById: (id: string) => PortalUser | undefined; canManage: boolean; saveWorkUpdate: (node: WorkNode, update: Omit<WorkUpdate, "id" | "createdAt" | "createdBy" | "source">) => Promise<boolean>; submitAcceptance: (node: WorkNode) => Promise<boolean>; resolveAcceptance: (acceptance: Acceptance, accepted: boolean) => Promise<boolean>; completeNode: (node: WorkNode) => Promise<boolean>; setModal: (modal: Modal) => void; asanaStatus: { configured: boolean; connected: boolean; connection?: Record<string, string> } | null; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; setNotice: Notify; openTree: (id: string) => void }) {
  const [filter, setFilter] = useState<"action" | "manage" | "acceptance" | "all">("action");
  const [listQuery, setListQuery] = useState("");
  const [sort, setSort] = useState<"deadline" | "priority" | "updated" | "progress">("deadline");
  const [levelFilter, setLevelFilter] = useState<"all" | NodeKind>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<"all" | LifecycleStatus>("all");
  const [workHealthFilter, setWorkHealthFilter] = useState<"all" | HealthStatus>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | WorkNode["priority"]>("all");
  const mine = payload.nodes.filter((node) => !node.archived && (node.ownerId === payload.currentUser.id || node.assigneeId === payload.currentUser.id || node.acceptorId === payload.currentUser.id || node.participantIds.includes(payload.currentUser.id)));
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  const filtered = mine.filter((node) => filter === "all" || filter === "action" && node.assigneeId === payload.currentUser.id && !["completed", "cancelled"].includes(node.lifecycle) || filter === "manage" && node.ownerId === payload.currentUser.id && node.assigneeId !== payload.currentUser.id || filter === "acceptance" && node.acceptorId === payload.currentUser.id && node.lifecycle === "acceptance")
    .filter((node) => !listQuery.trim() || `${node.code} ${node.title} ${node.result}`.toLowerCase().includes(listQuery.trim().toLowerCase()))
    .filter((node) => levelFilter === "all" || node.kind === levelFilter)
    .filter((node) => lifecycleFilter === "all" || node.lifecycle === lifecycleFilter)
    .filter((node) => workHealthFilter === "all" || node.health === workHealthFilter)
    .filter((node) => priorityFilter === "all" || node.priority === priorityFilter)
    .sort((a, b) => sort === "deadline" ? (a.plannedEnd || "9999").localeCompare(b.plannedEnd || "9999") : sort === "priority" ? priorityOrder[a.priority] - priorityOrder[b.priority] : sort === "progress" ? a.progress - b.progress : b.updatedAt.localeCompare(a.updatedAt));
  const current = payload.nodes.find((node) => node.id === selectedId && !node.archived) || selected || filtered[0] || mine[0];
  const latestAcceptance = current ? payload.acceptances.find((item) => item.nodeId === current.id && item.status === "submitted") : undefined;
  const children = current ? payload.nodes.filter((node) => node.parentId === current.id && !node.archived) : [];
  const mayWork = current && (canManage || current.ownerId === payload.currentUser.id || current.assigneeId === payload.currentUser.id);
  const pendingApprovals = payload.acceptances.filter((item) => item.status === "submitted" && item.acceptorId === payload.currentUser.id);
  const activeFilterCount = [levelFilter, lifecycleFilter, workHealthFilter, priorityFilter].filter((value) => value !== "all").length;
  const resetListFilters = () => { setLevelFilter("all"); setLifecycleFilter("all"); setWorkHealthFilter("all"); setPriorityFilter("all"); };

  return <>
    {pendingApprovals.length > 0 && <section className="approval-queue panel"><div className="panel-head"><div><span>Погодження</span><h2>Очікують вашого рішення</h2></div><b className="count amber">{pendingApprovals.length}</b></div><div>{pendingApprovals.map((acceptance) => { const node = payload.nodes.find((item) => item.id === acceptance.nodeId); return node ? <button key={acceptance.id} onClick={() => { setSelectedId(node.id); setFilter("acceptance"); }}><span>{node.code}</span><strong>{node.title}</strong><small>Передано {new Date(acceptance.submittedAt).toLocaleString("uk-UA")}</small></button> : null; })}</div></section>}
    <div className="my-workbench">
      <aside className="work-inbox"><label className="work-object-picker compact"><span>Обрати картку</span><select value={current?.id || ""} onChange={(event) => setSelectedId(event.target.value)}><option value="">Ціль, цикл або завдання…</option>{mine.map((node) => <option key={node.id} value={node.id}>{node.code} · {node.title}</option>)}</select></label><div className="work-filter">{(["action", "manage", "acceptance", "all"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "action" ? "Мої дії" : item === "manage" ? "Координую" : item === "acceptance" ? "Приймаю" : "Усі"}</button>)}</div><div className="work-list-controls"><input value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder="Пошук…" /><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="deadline">За строком</option><option value="priority">За пріоритетом</option><option value="updated">За оновленням</option><option value="progress">За прогресом</option></select></div><details className="work-advanced-filters"><summary><span>Фільтри</span>{activeFilterCount > 0 && <b>{activeFilterCount}</b>}<i>⌄</i></summary><div><label><span>Рівень</span><select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as typeof levelFilter)}><option value="all">Усі рівні</option><option value="goal">Цілі</option><option value="cycle">Цикли</option><option value="subcycle">Підцикли</option><option value="task">Завдання</option></select></label><label><span>Статус</span><select value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value as typeof lifecycleFilter)}><option value="all">Усі статуси</option>{Object.entries(lifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Стан</span><select value={workHealthFilter} onChange={(event) => setWorkHealthFilter(event.target.value as typeof workHealthFilter)}><option value="all">Будь-який стан</option><option value="normal">Нормально</option><option value="risk">Є ризик</option><option value="blocked">Заблоковано</option></select></label><label><span>Пріоритет</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}><option value="all">Усі пріоритети</option><option value="critical">Критичний</option><option value="high">Високий</option><option value="normal">Нормальний</option><option value="low">Низький</option></select></label><button type="button" disabled={!activeFilterCount} onClick={resetListFilters}>Скинути фільтри</button></div></details><div className="work-inbox-list">{filtered.map((node) => <button className={`work-list-row ${node.id === current?.id ? "selected" : ""}`} key={node.id} onClick={() => setSelectedId(node.id)}><div><span>{kindLabels[node.kind]} · {node.code}</span><strong>{node.title}</strong></div><StatusBadge node={node} /><footer><small>{node.progress}%</small><time>{dateLabel(node.plannedEnd)}</time></footer></button>)}{!filtered.length && <p className="empty-state padded">За вибраними фільтрами карток немає.</p>}</div></aside>
      {current ? <section className="work-desk"><header className="work-desk-head"><div><span>{kindLabels[current.kind]} · {current.code}</span><h2>{current.title}</h2><p>{current.result}</p></div><div><ProgressRing value={current.progress} />{current.lifecycle !== "completed" && mayWork && <button className="positive" onClick={() => void completeNode(current)}>Завершити</button>}<button className="secondary" onClick={() => openTree(current.id)}>Паспорт у дереві</button></div></header><div className="status-line"><StatusBadge node={current} />{current.decisionRequired && <span className="decision-badge">Потрібне рішення</span>}<span>Строк {dateLabel(current.plannedEnd)}</span><span>Прогноз {dateLabel(current.forecastEnd)}</span></div>
        <div className="work-summary-grid"><article><span>Власник результату</span><div className="person-line"><UserAvatar user={userById(current.ownerId)} compact /><strong>{userById(current.ownerId)?.name}</strong></div></article><article><span>Виконавець</span><div className="person-line"><UserAvatar user={userById(current.assigneeId)} compact /><strong>{userById(current.assigneeId)?.name}</strong></div></article><article><span>Приймає результат</span><div className="person-line"><UserAvatar user={userById(current.acceptorId)} compact /><strong>{userById(current.acceptorId)?.name}</strong></div></article></div>
        {current.kind === "task" ? <div className="execution-grid"><div><WorkStatusForm key={current.id} node={current} disabled={!mayWork} notify={setNotice} save={(update) => saveWorkUpdate(current, update)} /><section className="work-section"><div className="work-section-head"><div><span>Результат</span><h3>Докази та передання</h3></div><button onClick={() => setModal("evidence")}>+ Додати доказ</button></div><p>{current.acceptanceCriteria}</p><div className="evidence-stack">{current.evidence.map((item) => <a key={item.id} href={item.kind === "note" ? undefined : item.value} target="_blank" rel="noreferrer"><b>{item.label}</b><span>{item.kind === "file" ? "Файл" : item.kind === "link" ? "Посилання" : item.value}</span></a>)}{!current.evidence.length && <span className="empty-state">Доказів ще немає.</span>}</div><div className="work-action-row"><button onClick={() => setModal("blocker")}>Додати блокер</button><button onClick={() => setModal("decision")}>Запитати рішення</button><button onClick={() => setModal("dependency")}>Додати залежність</button>{!["acceptance", "completed"].includes(current.lifecycle) && <button className="primary" onClick={() => void submitAcceptance(current)}>Передати на приймання</button>}</div>{latestAcceptance && (payload.currentUser.id === latestAcceptance.acceptorId || canManage) && <div className="acceptance-box"><strong>Результат очікує приймання</strong><div><button className="negative" onClick={() => void resolveAcceptance(latestAcceptance, false)}>Повернути</button><button className="positive" onClick={() => void resolveAcceptance(latestAcceptance, true)}>Прийняти</button></div></div>}</section></div><aside><AsanaSyncPanel key={`${current.id}-${current.asana.taskGid}`} payload={payload} selected={current} asanaStatus={asanaStatus} mutate={mutate} setNotice={setNotice} compact /><WorkUpdateHistory node={current} userById={userById} /></aside></div> : <div className="aggregate-work"><section className="work-section aggregate-note"><span>Агрегований рівень</span><h3>Стан цього рівня формується з нижчих рівнів</h3><p>Прогрес, ризик і статус перераховуються після кожного звіту по завданню. Для підциклу додатково зберігається координаційний знімок.</p>{["cycle", "subcycle"].includes(current.kind) && <button className="primary" onClick={() => setModal("coordination")}>Зафіксувати координацію</button>}</section><section className="work-section"><div className="work-section-head"><div><span>Нижчі рівні</span><h3>Джерела стану</h3></div><b>{children.length}</b></div><div className="aggregate-children">{children.map((node) => <button key={node.id} onClick={() => setSelectedId(node.id)}><span>{node.code}</span><strong>{node.title}</strong><em>{node.progress}%</em><StatusBadge node={node} /></button>)}</div></section></div>}
        <DiscussionPanel node={current} payload={payload} mutate={mutate} notify={setNotice} userById={userById} />
      </section> : <section className="work-desk empty-work"><h2>Робочих карток ще немає</h2><p>Після створення цілі, циклу або завдання доступні вам картки з’являться тут.</p></section>}
    </div>
  </>;
}

function WorkStatusForm({ node, disabled, save, notify }: { node: WorkNode; disabled: boolean; save: (update: Omit<WorkUpdate, "id" | "createdAt" | "createdBy" | "source">) => Promise<boolean>; notify: Notify }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:work-draft:${node.id}`, { lifecycle: node.lifecycle, health: node.health, progress: node.progress, forecastEnd: node.forecastEnd, summary: "", nextAction: "" });
  const [busy, setBusy] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  useEffect(() => {
    if (form.summary || form.nextAction) return;
    // Keep untouched controls aligned with automatic updates from other users.
    setForm((current) => ({ ...current, lifecycle: node.lifecycle, health: node.health, progress: node.progress, forecastEnd: node.forecastEnd }));
  }, [form.nextAction, form.summary, node.forecastEnd, node.health, node.lifecycle, node.progress, setForm]);
  const submit = async () => {
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
  return <section className="work-section status-update"><div className="work-section-head"><div><span>Фактичний стан</span><h3>Оновлення та звіт</h3></div><StatusBadge node={{ ...node, lifecycle: form.lifecycle, health: form.health }} /></div><div className="status-form-grid"><Field label="Стан" required hint="Фактичний етап виконання завдання на момент звіту."><select value={form.lifecycle} disabled={disabled} onChange={(event) => setForm({ ...form, lifecycle: event.target.value as LifecycleStatus })}>{Object.entries(lifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Стан здоров’я" required hint="Нормально — рух за планом; ризик — строк або результат під загрозою; заблоковано — рух неможливий без окремої реакції."><select value={form.health} disabled={disabled} onChange={(event) => setForm({ ...form, health: event.target.value as HealthStatus })}>{Object.entries(healthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={`Прогрес · ${form.progress}%`} required hint="Оцініть частку вже отриманого результату, а не витрачений час."><input type="range" min="0" max="100" value={form.progress} disabled={disabled} onChange={(event) => setForm({ ...form, progress: Number(event.target.value) })} /></Field><Field label="Прогноз завершення" hint="Оновіть дату, якщо фактичний прогноз відрізняється від планового строку."><input type="date" value={form.forecastEnd} disabled={disabled} onChange={(event) => setForm({ ...form, forecastEnd: event.target.value })} /></Field><Field wide label="Що зроблено / фактичний результат" required error={summaryError} hint="Фіксуйте перевірюваний результат, а не процес або витрачений час." example="Оновлено сторінку послуги, перевірено 12 посилань, передано на погодження власнику результату."><textarea value={form.summary} disabled={disabled} aria-invalid={Boolean(summaryError)} onChange={(event) => { setForm({ ...form, summary: event.target.value }); setSummaryError(""); }} placeholder="Наприклад: підготовлено макет і передано на погодження" /></Field><Field wide label="Наступна дія" hint="Наступний конкретний крок, відповідальний та умова або строк." example="До 18.08 Валентина вносить правки після погодження Володимира."><textarea value={form.nextAction} disabled={disabled} onChange={(event) => setForm({ ...form, nextAction: event.target.value })} placeholder="Наприклад: внести правки після погодження власника" /></Field></div><button className="primary full-action" disabled={disabled || busy} onClick={() => void submit()}>{busy ? "Зберігаємо…" : "Зберегти стан і подати звіт"}</button></section>;
}

function WorkUpdateHistory({ node, userById }: { node: WorkNode; userById: (id: string) => PortalUser | undefined }) {
  return <section className="work-section update-panel"><div className="work-section-head"><div><span>Системний слід</span><h3>Останні звіти</h3></div><b>{(node.updates || []).length}</b></div><div className="update-history">{(node.updates || []).slice(0, 8).map((update) => <article key={update.id}><time>{new Date(update.createdAt).toLocaleString("uk-UA")}</time><strong>{lifecycleLabels[update.lifecycle]} · {update.progress}%</strong><p>{update.summary}</p><small>{userById(update.createdBy)?.name || "Asana"}{update.nextAction ? ` · Далі: ${update.nextAction}` : ""}</small></article>)}{!(node.updates || []).length && <p className="empty-state">Звітів ще немає.</p>}</div></section>;
}

function DiscussionPanel({ node, payload, mutate, notify, userById }: { node: WorkNode; payload: PortalPayload; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; notify: Notify; userById: (id: string) => PortalUser | undefined }) {
  const [draft, setDraft, clearDraft] = usePersistentDraft(`portal:discussion-draft:${node.id}`, { text: "", kind: "comment" as "comment" | "question" });
  const [busy, setBusy] = useState(false);
  const messages = (payload.discussions || []).filter((message) => message.nodeId === node.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const send = async () => {
    if (!draft.text.trim()) { notify("Напишіть повідомлення для учасників картки.", "error"); return; }
    setBusy(true);
    const message: DiscussionMessage = { id: crypto.randomUUID(), nodeId: node.id, authorId: payload.currentUser.id, text: draft.text.trim(), kind: draft.kind, createdAt: isoNow() };
    const ok = await mutate(`Додано повідомлення до ${node.code}`, node.id, (state) => state.discussions.push(message));
    if (ok) { setDraft({ text: "", kind: "comment" }); clearDraft(); }
    setBusy(false);
  };
  const resolveQuestion = (message: DiscussionMessage) => mutate(`Закрито питання в ${node.code}`, node.id, (state) => { const target = state.discussions.find((item) => item.id === message.id); if (target) { target.resolvedAt = isoNow(); target.resolvedBy = payload.currentUser.id; } });
  return <section className="work-section discussion-panel"><div className="work-section-head"><div><span>Внутрішнє обговорення</span><h3>Питання, погодження та коментарі</h3></div><b>{messages.length}</b></div><div className="discussion-list">{messages.slice(-20).map((message) => <article key={message.id} className={`${message.kind} ${message.resolvedAt ? "resolved" : ""}`}><div><UserAvatar compact user={userById(message.authorId)} /><strong>{userById(message.authorId)?.name || "Система"}</strong>{message.kind === "question" && <span className="question-state">{message.resolvedAt ? "Закрито" : "Відкрите питання"}</span>}<time>{new Date(message.createdAt).toLocaleString("uk-UA")}</time></div><p>{message.text}</p>{message.kind === "question" && !message.resolvedAt && <button className="resolve-question" onClick={() => void resolveQuestion(message)}>Закрити питання</button>}</article>)}{!messages.length && <p className="empty-state">Повідомлень ще немає. Обговорення зберігається в картці.</p>}</div><div className="discussion-compose"><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as "comment" | "question" })}><option value="comment">Коментар</option><option value="question">Питання</option></select><textarea value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} placeholder="Напишіть питання, коментар або умову погодження…" /><button className="primary" disabled={busy || !draft.text.trim()} onClick={() => void send()}>{busy ? "Надсилаємо…" : "Надіслати"}</button></div></section>;
}

function CoordinationView({ payload, userById, select, open }: { payload: PortalPayload; userById: (id: string) => PortalUser | undefined; select: (id: string) => void; open: (node: WorkNode) => void }) {
  const [query, setQuery] = useState("");
  const [ownerId, setOwnerId] = useState("all");
  const [state, setState] = useState<"all" | "risk" | "active" | "completed">("all");
  const subcycles = payload.nodes.filter((node) => node.kind === "subcycle" && !node.archived);
  const directCycles = payload.nodes.filter((node) => node.kind === "cycle" && !node.archived && payload.nodes.some((task) => task.kind === "task" && task.parentId === node.id && !task.archived));
  const units = [
    ...subcycles.map((node) => ({ node, label: "Підцикл", tasks: descendants(payload.nodes, node.id).filter((item) => item.kind === "task") })),
    ...directCycles.map((node) => ({ node, label: "Прямі завдання циклу", tasks: payload.nodes.filter((item) => item.kind === "task" && item.parentId === node.id && !item.archived) })),
  ].filter(({ node }) => {
    const matchesQuery = !query.trim() || `${node.code} ${node.title}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesOwner = ownerId === "all" || node.ownerId === ownerId || node.assigneeId === ownerId;
    const matchesState = state === "all" || state === "risk" && node.health !== "normal" || state === "active" && !["completed", "cancelled"].includes(node.lifecycle) || state === "completed" && node.lifecycle === "completed";
    return matchesQuery && matchesOwner && matchesState;
  });
  const visibleNodeIds = new Set(units.flatMap(({ node, tasks }) => [...nodePath(payload.nodes, node).map((item) => item.id), ...tasks.map((task) => task.id)]));
  const openQuestions = (payload.discussions || []).filter((message) => message.kind === "question" && !message.resolvedAt && visibleNodeIds.has(message.nodeId));
  return <><PageIntro kicker="Одиниця управління" title="Координація за циклами й підциклами" text="Фактичний стан формується з завдань, блокерів і рішень; прямі завдання циклів більше не губляться." actions={<div className="page-filter-bar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Пошук координації…" /><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="all">Усі відповідальні</option>{payload.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select><select value={state} onChange={(event) => setState(event.target.value as typeof state)}><option value="all">Усі стани</option><option value="active">Активні</option><option value="risk">Ризик / блокер</option><option value="completed">Завершені</option></select></div>} />
    <section className="panel coordination-questions"><div className="panel-head"><div><span>Відкриті питання</span><h2>Потребують відповіді під час координації</h2></div><b className="count amber">{openQuestions.length}</b></div><div>{openQuestions.map((message) => { const node = payload.nodes.find((item) => item.id === message.nodeId); return <button key={message.id} onClick={() => select(message.nodeId)}><span>{node?.code || "—"}</span><strong>{message.text}</strong><small>{userById(message.authorId)?.name} · {new Date(message.createdAt).toLocaleString("uk-UA")}</small></button>; })}{!openQuestions.length && <p className="empty-state padded">Незакритих питань за вибраними фільтрами немає.</p>}</div></section>
    <div className="coordination-list">{units.map(({ node, tasks: branch, label }) => {
      const blockers = payload.blockers.filter((item) => item.status === "open" && branch.some((task) => task.id === item.nodeId));
      const decisions = payload.decisions.filter((item) => item.status === "requested" && branch.some((task) => task.id === item.nodeId));
      const snapshots = payload.coordinations.filter((item) => item.subcycleId === node.id);
      return <article className="coordination-card" key={`${node.id}-${label}`}><header><div><span>{label} · {node.code}</span><h2>{node.title}</h2></div><StatusBadge node={node} /></header><div className="coordination-body"><ProgressRing value={branch.length ? Math.round(branch.reduce((sum, task) => sum + task.progress, 0) / branch.length) : node.progress} /><div className="coordination-metrics"><div><strong>{branch.filter((task) => task.lifecycle === "completed").length}/{branch.length}</strong><span>завершено</span></div><div className="red"><strong>{blockers.length}</strong><span>блокери</span></div><div className="amber"><strong>{decisions.length}</strong><span>рішення</span></div><div><strong>{snapshots.length}</strong><span>знімки</span></div></div></div><div className="coordination-task-list">{branch.map((task) => <button key={task.id} onClick={() => select(task.id)}><span>{task.code}</span><strong>{task.title}</strong><em>{task.progress}%</em><StatusBadge node={task} /></button>)}</div><footer><div><UserAvatar compact user={userById(node.ownerId)} /><span>{userById(node.ownerId)?.name} · {node.coordinationCadence || "Без графіка"}</span></div><div><button onClick={() => select(node.id)}>Відкрити</button><button className="primary" onClick={() => open(node)}>Нова координація</button></div></footer></article>;
    })}{!units.length && <p className="empty-state padded">За вибраними фільтрами одиниць координації немає.</p>}</div>
  </>;
}

function RiskRegisters({ payload, userById, mutate, select }: { payload: PortalPayload; userById: (id: string) => PortalUser | undefined; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; select: (id: string) => void }) {
  const openBlockers = payload.blockers.filter((item) => item.status === "open");
  const openDecisions = payload.decisions.filter((item) => item.status === "requested");
  return <div className="risk-layout"><section className="panel"><div className="panel-head"><div><span>Блокери</span><h2>Відкриті перешкоди</h2></div><b className="count red">{openBlockers.length}</b></div><div className="register-list">{openBlockers.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <article key={item.id}><div className="register-top"><button onClick={() => select(item.nodeId)}>{node?.code}</button><span>до {dateLabel(item.decisionDue)}</span></div><h3>{item.title}</h3><p>{item.facts}</p><dl><dt>Рекомендація</dt><dd>{item.recommendation}</dd><dt>Ескалація</dt><dd>{userById(item.escalationToId)?.name}</dd></dl><button className="resolve" onClick={() => mutate("Блокер усунено", item.nodeId, (state) => { const blocker = state.blockers.find((candidate) => candidate.id === item.id)!; blocker.status = "resolved"; blocker.resolvedAt = isoNow(); const hasOther = state.blockers.some((candidate) => candidate.nodeId === item.nodeId && candidate.id !== item.id && candidate.status === "open"); if (!hasOther) state.nodes.find((candidate) => candidate.id === item.nodeId)!.health = "normal"; })}>Позначити усуненим</button></article>; })}{!openBlockers.length && <p className="empty-state padded">Відкритих блокерів немає.</p>}</div></section>
      <section className="panel"><div className="panel-head"><div><span>Рішення</span><h2>Очікують рішення</h2></div><b className="count amber">{openDecisions.length}</b></div><div className="register-list">{openDecisions.map((item) => { const node = payload.nodes.find((candidate) => candidate.id === item.nodeId); return <article key={item.id}><div className="register-top"><button onClick={() => select(item.nodeId)}>{node?.code}</button><span>до {dateLabel(item.dueDate)}</span></div><h3>{item.question}</h3><p>{item.options}</p><dl><dt>Рекомендація</dt><dd>{item.recommendation}</dd><dt>Приймає рішення</dt><dd>{userById(item.decisionOwnerId)?.name}</dd></dl><button className="resolve" onClick={() => mutate("Управлінське рішення прийнято", item.nodeId, (state) => { const decision = state.decisions.find((candidate) => candidate.id === item.id)!; decision.status = "decided"; decision.decidedAt = isoNow(); decision.resolution = decision.recommendation; const hasOther = state.decisions.some((candidate) => candidate.nodeId === item.nodeId && candidate.id !== item.id && candidate.status === "requested"); if (!hasOther) state.nodes.find((candidate) => candidate.id === item.nodeId)!.decisionRequired = false; })}>Прийняти рекомендацію</button></article>; })}{!openDecisions.length && <p className="empty-state padded">Відкритих рішень немає.</p>}</div></section></div>
  ;
}

function ReportAnalytics({ payload, data, userById, healthFilter, setHealthFilter, query, ownerId, select }: { payload: PortalPayload; data: ComputedData; userById: (id: string) => PortalUser | undefined; healthFilter: "all" | HealthStatus | "overdue" | "decision"; setHealthFilter: (value: "all" | HealthStatus | "overdue" | "decision") => void; query: string; ownerId: string; select: (id: string) => void }) {
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
    <section id="control-register" className="panel report-table"><div className="report-filter"><div><h2>Контрольний реєстр</h2><span>{filtered.length} завдань</span></div><div>{(["all", "blocked", "risk", "overdue", "decision"] as const).map((filter) => <button key={filter} className={healthFilter === filter ? "active" : ""} onClick={() => setHealthFilter(filter)}>{filter === "all" ? "Усі" : filter === "blocked" ? "Блокери" : filter === "risk" ? "Ризик" : filter === "overdue" ? "Прострочені" : "Потрібне рішення"}</button>)}</div></div><div className="table-wrap"><table><thead><tr><th>Код</th><th>Завдання</th><th>Виконавець</th><th>Стан</th><th>Прогрес</th><th>Строк</th></tr></thead><tbody>{filtered.map((node) => <tr key={node.id} onClick={() => select(node.id)}><td><b>{node.code}</b></td><td>{node.title}</td><td>{userById(node.assigneeId)?.name}</td><td><StatusBadge node={node} /></td><td>{node.progress}%</td><td>{dateLabel(node.plannedEnd)}</td></tr>)}</tbody></table></div></section>
  </>;
}

function AsanaSyncPanel({ payload, selected, asanaStatus, mutate, setNotice, compact = false }: { payload: PortalPayload; selected: WorkNode; asanaStatus: { configured: boolean; connected: boolean; connection?: Record<string, string> } | null; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; setNotice: Notify; compact?: boolean }) {
  const [taskGid, setTaskGid] = useState(selected?.asana.taskGid || "");
  const [projectGid, setProjectGid] = useState(selected?.asana.projectGid || "");
  const [asanaProjects, setAsanaProjects] = useState<Array<{ gid: string; name: string; workspace: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!asanaStatus?.connected) return;
    fetch("/api/asana/projects", { cache: "no-store" })
      .then(async (response) => { const result = (await response.json()) as { projects?: Array<{ gid: string; name: string; workspace: string }> }; if (!response.ok) throw new Error(); return result.projects || []; })
      .then(setAsanaProjects)
      .catch(() => setAsanaProjects([]));
  }, [asanaStatus?.connected]);
  const normalizeTaskGid = (value: string) => value.match(/\d{8,}/g)?.at(-1) || value.trim();
  const sync = async (action: "read" | "create" | "update") => {
    setBusy(true); setNotice("");
    try {
      const normalizedTaskGid = normalizeTaskGid(taskGid);
      const response = await fetch("/api/asana/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, nodeId: selected.id, taskGid: normalizedTaskGid, projectGid, title: selected.title, description: `${selected.code}\n\n${selected.result}\n\nКритерій приймання: ${selected.acceptanceCriteria}`, dueOn: selected.plannedEnd, completed: selected.lifecycle === "completed" }) });
      const result = (await response.json()) as { error?: string; data?: { gid?: string; name?: string; notes?: string; due_on?: string | null; completed?: boolean; permalink_url?: string; modified_at?: string; assignee?: { email?: string } } };
      if (!response.ok) throw new Error(result.error || "Помилка Asana");
      const task = result.data || {};
      await mutate(`Синхронізовано ${selected.code} з Asana`, selected.id, (state) => {
        const node = state.nodes.find((item) => item.id === selected.id)!;
        if (action === "read") {
          if (node.asana.rules.title === "asana") node.title = task.name || node.title;
          if (node.asana.rules.dates === "asana") node.plannedEnd = task.due_on || node.plannedEnd;
          if (node.asana.rules.status === "asana") node.lifecycle = task.completed ? "completed" : node.lifecycle === "completed" ? "in_progress" : node.lifecycle;
          if (node.asana.rules.description === "asana" && task.notes) node.description = task.notes;
          if (node.asana.rules.assignee === "asana" && task.assignee?.email) node.assigneeId = state.users.find((candidate) => candidate.email.toLowerCase() === task.assignee?.email?.toLowerCase())?.id || node.assigneeId;
          if (task.completed) {
            node.progress = 100;
            node.actualEnd = isoNow().slice(0, 10);
          }
          node.updates = [{ id: crypto.randomUUID(), lifecycle: task.completed ? "completed" : node.lifecycle, health: node.health, progress: task.completed ? 100 : node.progress, forecastEnd: node.forecastEnd, summary: task.notes?.trim() || `Фактичний стан отримано з Asana: ${task.name || node.title}`, nextAction: task.completed ? "Передати результат на приймання в порталі" : "Продовжити виконання в Asana", createdAt: task.modified_at || isoNow(), createdBy: payload.currentUser.id, source: "asana" }, ...(node.updates || [])];
        }
        node.asana.taskGid = task?.gid || taskGid;
        node.asana.taskUrl = task?.permalink_url || node.asana.taskUrl;
        node.asana.projectGid = projectGid;
        node.asana.lastSyncedAt = isoNow();
        node.asana.syncState = "linked";
      });
      setTaskGid(task?.gid || taskGid);
      setNotice("Синхронізацію виконано");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Помилка синхронізації", "error"); }
    finally { setBusy(false); }
  };
  const syncPanel = <section className={compact ? "work-section asana-work" : "panel sync-workbench"}><div className="panel-head"><div><span>Пов’язана задача Asana</span><h2>{selected.code} · {selected.title}</h2></div><span className={`connection-state ${asanaStatus?.connected ? "connected" : ""}`}>{asanaStatus?.connected ? "Підключено" : "Не підключено"}</span></div><div className="sync-grid"><label><span>Посилання або GID задачі Asana</span><input value={taskGid} onChange={(event) => setTaskGid(event.target.value)} placeholder="Вставте посилання на наявну задачу" /></label><label><span>Проєкт для нової задачі</span>{asanaProjects.length ? <select value={projectGid} onChange={(event) => setProjectGid(event.target.value)}><option value="">Оберіть проєкт Asana</option>{asanaProjects.map((project) => <option key={project.gid} value={project.gid}>{project.name} · {project.workspace}</option>)}</select> : <input value={projectGid} onChange={(event) => setProjectGid(event.target.value.trim())} placeholder="GID проєкту, якщо перелік недоступний" />}</label></div>{!compact && <div className="mapping-table"><div className="mapping-head"><span>Поле</span><span>Контрольне джерело</span></div>{Object.entries(selected.asana.rules).map(([field, rule]) => <div key={field}><span>{field === "title" ? "Назва" : field === "assignee" ? "Виконавець" : field === "dates" ? "Дати" : field === "status" ? "Стан" : "Опис"}</span><select value={rule} onChange={(event) => mutate(`Змінено правило синхронізації ${field}`, selected.id, (state) => { const node = state.nodes.find((item) => item.id === selected.id)!; node.asana.rules[field as keyof typeof node.asana.rules] = event.target.value as "portal" | "asana" | "manual"; })}><option value="portal">Портал</option><option value="asana">Asana</option><option value="manual">Ручне узгодження</option></select></div>)}</div>}<div className="sync-actions"><button disabled={!asanaStatus?.connected || busy || !taskGid} onClick={() => void sync("read")}>Отримати стан і результат</button><button disabled={!asanaStatus?.connected || busy || !projectGid} onClick={() => void sync("create")}>Створити задачу в Asana</button><button className="primary" disabled={!asanaStatus?.connected || busy || !taskGid} onClick={() => void sync("update")}>Передати зміни</button></div>{compact && selected.asana.taskUrl && <a className="asana-task-link" href={selected.asana.taskUrl} target="_blank" rel="noreferrer">Відкрити пов’язану задачу в Asana ↗</a>}<p className="sync-note">Портал зберігає управлінський результат і звіт. Asana може бути місцем фактичного виконання задачі; джерело кожного поля визначається окремо в налаштуваннях.</p></section>;
  if (compact) return syncPanel;
  return <><div className="integration-grid single"><section className="panel integration-main"><div className="integration-brand"><div className="asana-logo">A</div><div><span>Asana</span><h2>{asanaStatus?.connected ? "Особистий акаунт підключено" : "Підключення очікується"}</h2><p>{asanaStatus?.configured ? "OAuth налаштовано. Після підключення можна створювати, отримувати та передавати зміни задач." : "Потрібні ключі Asana OAuth-застосунку для цього середовища."}</p></div><span className={`connection-state ${asanaStatus?.connected ? "connected" : ""}`}>{asanaStatus?.connected ? "Підключено" : "Не підключено"}</span></div>{asanaStatus?.connected ? <div className="connected-user"><strong>{String(asanaStatus.connection?.asana_user_name || payload.currentUser.name)}</strong><small>Зміни виконуватимуться від цього користувача</small></div> : <a className={`button-link ${!asanaStatus?.configured ? "disabled" : ""}`} href={asanaStatus?.configured ? "/api/asana/start" : undefined}>Підключити мій Asana-акаунт</a>}</section></div>{syncPanel}</>;
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

function SettingsView({ payload, selected, setSelectedId, asanaStatus, telegramStatus, setTelegramStatus, mutate, setNotice, reload }: { payload: PortalPayload; selected?: WorkNode; setSelectedId: (id: string) => void; asanaStatus: { configured: boolean; connected: boolean; connection?: Record<string, string> } | null; telegramStatus: TelegramStatus | null; setTelegramStatus: (status: TelegramStatus) => void; mutate: (action: string, entityId: string, recipe: (state: PortalState) => void) => Promise<boolean>; setNotice: Notify; reload: () => Promise<PortalPayload> }) {
  return <><PageIntro kicker="Адміністрування" title="Налаштування, бібліотеки та інтеграції" text="Тут адміністратор керує довідниками порталу, ролями доступу, повтореннями й правилами обміну з зовнішніми системами." />
    <div className="settings-section-head"><span>Бібліотеки</span><h2>Учасники порталу та відповідальні</h2><p>Записи цієї бібліотеки використовуються в усіх полях власника, виконавця, приймання та ескалації.</p></div>
    <UserLibraryEditor payload={payload} reload={reload} setNotice={setNotice} />
    <div className="settings-section-head"><div><span>Інтеграції</span><h2>Asana та канали повідомлень</h2></div>{selected && <label className="settings-node-picker"><span>Ціль, цикл або завдання для синхронізації</span><select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{payload.nodes.filter((node) => !node.archived).map((node) => <option key={node.id} value={node.id}>{node.code} · {node.title}</option>)}</select></label>}</div>
    {selected ? <AsanaSyncPanel key={`${selected.id}-settings`} payload={payload} selected={selected} asanaStatus={asanaStatus} mutate={mutate} setNotice={setNotice} /> : <section className="panel integration-empty"><h2>Синхронізація з Asana</h2><p>Створіть хоча б одну ціль, цикл або завдання, щоб налаштувати обмін даними з Asana.</p></section>}
    <TelegramPanel payload={payload} status={telegramStatus} setStatus={setTelegramStatus} notify={setNotice} />
    <div className="settings-layout settings-bottom"><section className="panel"><div className="panel-head"><div><span>Розвиток</span><h2>Повторювані цикли</h2></div><span className="planned-label">Архітектуру закладено</span></div><p className="panel-copy">Кожна ціль, цикл, підцикл або завдання має правило повторення, інтервал і наступну дату. Автоматичне створення екземплярів буде ввімкнено після першого реального повторюваного циклу.</p><div className="future-box"><strong>Майбутній сценарій</strong><span>Шаблон → дата запуску → новий екземпляр → зв’язок із попереднім періодом → окрема звітність.</span></div></section><section className="panel"><div className="panel-head"><div><span>Довідники наступної черги</span><h2>Кероване розширення</h2></div></div><div className="library-roadmap"><span>Ролі та повноваження</span><span>Типи результатів</span><span>Причини блокерів</span><span>Шаблони координації</span><span>Джерела даних</span></div></section></div>
    <section className="panel audit-panel"><div className="panel-head"><div><span>Контроль</span><h2>Журнал змін</h2></div><span>{payload.audit.length} записів</span></div><div className="audit-list">{payload.audit.slice(0, 30).map((entry) => <div key={entry.id}><time>{new Date(entry.at).toLocaleString("uk-UA")}</time><strong>{entry.action}</strong><span>{entry.by}</span><code>{entry.entityId}</code></div>)}</div></section>
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-label={title}><header><div><span>{subtitle}</span><h2>{title}</h2></div><button onClick={close} aria-label="Закрити">×</button></header><div className="modal-body">{children}</div><footer>{footer}</footer></section></div>;
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
      <Field label="Власник результату" required error={errors.ownerId} hint="Відповідає за цінність і остаточний результат верхнього рівня."><select value={node.ownerId} aria-invalid={Boolean(errors.ownerId)} onChange={(event) => update("ownerId", event.target.value)}>{users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
      <Field label="Виконавець" required error={errors.assigneeId} hint="Людина, яка виконує завдання або координує нижчі рівні."><select value={node.assigneeId} aria-invalid={Boolean(errors.assigneeId)} onChange={(event) => update("assigneeId", event.target.value)}>{users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
      <Field label="Приймає результат" required error={errors.acceptorId} hint="Перевіряє результат за критерієм приймання та приймає або повертає його."><select value={node.acceptorId} aria-invalid={Boolean(errors.acceptorId)} onChange={(event) => update("acceptorId", event.target.value)}>{users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
      <Field label="Пріоритет" required hint="Визначає порядок управлінської уваги, якщо одночасно конкурують кілька робіт."><select value={node.priority} onChange={(event) => update("priority", event.target.value as WorkNode["priority"])}><option value="critical">Критичний</option><option value="high">Високий</option><option value="normal">Нормальний</option><option value="low">Низький</option></select></Field>
      <Field wide label="Учасники" hint="Особи, яким потрібен доступ до об’єкта або участь у його виконанні."><div className="participant-picker">{users.filter((user) => user.active).map((user) => <label key={user.id}><input type="checkbox" checked={node.participantIds.includes(user.id)} onChange={(event) => update("participantIds", event.target.checked ? [...node.participantIds, user.id] : node.participantIds.filter((id) => id !== user.id))} /><span>{user.name}</span></label>)}</div></Field>
      <Field label="Початок" hint="Планова дата, якщо її можна визначити наперед."><input type="date" value={node.plannedStart} onChange={(event) => update("plannedStart", event.target.value)} /></Field>
      <Field label="Завершення" hint="Погоджений плановий строк готового результату."><input type="date" value={node.plannedEnd} onChange={(event) => update("plannedEnd", event.target.value)} /></Field>
      <Field label="Прогноз" hint="Поточна реалістична дата завершення; може відрізнятися від плану."><input type="date" value={node.forecastEnd} onChange={(event) => update("forecastEnd", event.target.value)} /></Field>
      <Field label="Прогрес, %" required hint={node.kind === "task" ? "Частка фактично отриманого результату, а не витраченого часу." : "Для цілі, циклу й підциклу прогрес автоматично розраховується з нижчих рівнів."}><input type="number" min="0" max="100" value={node.progress} disabled={node.kind !== "task"} onChange={(event) => update("progress", Number(event.target.value))} /></Field>
      <Field label="Спосіб початку" required hint="Визначає, коли робота може стартувати: разом із батьківським рівнем, за датою, після залежності або після звільнення ресурсу."><select value={node.startMode} onChange={(event) => update("startMode", event.target.value as StartMode)}>{Object.entries(startLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Періодичність координації" hint="Як часто власник або координатор переглядає стан цього рівня." example="Щопонеділка о 10:00 або щотижня"><input value={node.coordinationCadence} onChange={(event) => update("coordinationCadence", event.target.value)} placeholder="Наприклад: щотижня" /></Field>
      <Field wide label="Повноваження" hint="Які рішення відповідальний може приймати самостійно та що повинен погоджувати."><textarea value={node.authority} onChange={(event) => update("authority", event.target.value)} placeholder="Самостійні рішення, межі та ескалація" /></Field>
      <Field wide label="Ресурс" hint="Люди, бюджет, матеріали, доступи або час, потрібні для результату."><textarea value={node.resource} onChange={(event) => update("resource", event.target.value)} placeholder="Наприклад: 8 годин дизайнера та доступ до CMS" /></Field>
      <Field wide label="Контрольне місце" hint="Система або сторінка, де перевіряється фактичне виконання. Кнопка «+» додає ще одне контрольне місце." example="Asana, CRM, сторінка сайту або реєстр договорів"><div className="multi-value-field">{controlPlaces.map((place, index) => <div key={index}><input value={place} onChange={(event) => setControlPlace(index, event.target.value)} placeholder="Наприклад: Asana або сторінка сайту" />{index === controlPlaces.length - 1 && <button type="button" onClick={() => update("controlPlace", `${node.controlPlace}${node.controlPlace ? "\n" : ""}`)} aria-label="Додати контрольне місце">+</button>}</div>)}</div></Field>
      <Field label="Доступ" required hint="Визначає, хто бачить об’єкт та його робочі дані."><select value={node.visibility} onChange={(event) => update("visibility", event.target.value as WorkNode["visibility"])}><option value="company">Уся компанія</option><option value="participants">Лише учасники</option></select></Field>
      <Field label="Повторення" hint="Для циклів і завдань, які повторюються за однаковим правилом."><select value={node.recurrence.enabled ? node.recurrence.frequency : "off"} onChange={(event) => setNode({ ...node, recurrence: { ...node.recurrence, enabled: event.target.value !== "off", frequency: event.target.value === "off" ? "monthly" : event.target.value as WorkNode["recurrence"]["frequency"] } })}><option value="off">Немає</option><option value="weekly">Щотижня</option><option value="monthly">Щомісяця</option><option value="quarterly">Щокварталу</option><option value="yearly">Щороку</option></select></Field>
    </div>
  </ModalShell>;
}

function BlockerModal({ node, users, notify, close, save }: { node: WorkNode; users: PortalUser[]; notify: Notify; close: () => void; save: (blocker: Blocker) => void }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:blocker-draft:${node.id}`, { title: "", facts: "", cause: "", actionsTaken: "", ownerId: node.assigneeId, escalationToId: node.ownerId, recommendation: "", impact: "", decisionDue: node.plannedEnd });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (key: string, value: string) => { setErrors((current) => ({ ...current, [key]: "" })); setForm({ ...form, [key]: value }); };
  const submit = () => {
    const next = { title: !form.title.trim() ? "Вкажіть, що саме зупинило виконання." : "", facts: !form.facts.trim() ? "Зафіксуйте перевірювані факти без припущень." : "", ownerId: !form.ownerId ? "Оберіть відповідального за усунення." : "", escalationToId: !form.escalationToId ? "Оберіть адресата ескалації." : "", decisionDue: !form.decisionDue ? "Вкажіть строк реакції." : "" };
    const active = Object.fromEntries(Object.entries(next).filter(([, value]) => value));
    if (Object.keys(active).length) { setErrors(active); notify("Не вдалося зберегти блокер: перевірте виділені поля.", "error"); focusFirstError(); return; }
    clearDraft(); save({ id: crypto.randomUUID(), nodeId: node.id, ...form, status: "open", createdAt: isoNow(), resolvedAt: "" });
  };
  return <ModalShell title={`Блокер для ${node.code}`} subtitle="Раннє реагування" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Зафіксувати блокер</button></>}><div className="form-grid"><Field wide label="Що заблоковано" required error={errors.title} hint="Назвіть конкретний результат або наступну дію, які зараз неможливі." example="Неможливо опублікувати сторінку через відсутність погодженого тексту."><input value={form.title} aria-invalid={Boolean(errors.title)} onChange={(event) => update("title", event.target.value)} placeholder="Наприклад: публікацію зупинено" /></Field><Field wide label="Факти" required error={errors.facts} hint="Лише спостережувані факти: що відсутнє, коли виявлено, яка дія не виконується."><textarea value={form.facts} aria-invalid={Boolean(errors.facts)} onChange={(event) => update("facts", event.target.value)} placeholder="Наприклад: станом на 14.08 погодження власника не отримано" /></Field><Field wide label="Причина" hint="Відома першопричина. Якщо її ще не встановлено, так і зазначте."><textarea value={form.cause} onChange={(event) => update("cause", event.target.value)} placeholder="Наприклад: не визначено; потрібна перевірка" /></Field><Field wide label="Уже виконані дії" hint="Що вже зроблено для усунення перешкоди та який був результат."><textarea value={form.actionsTaken} onChange={(event) => update("actionsTaken", event.target.value)} placeholder="Наприклад: надіслано нагадування 13.08, відповіді немає" /></Field><Field label="Відповідальний" required error={errors.ownerId} hint="Людина, яка організовує усунення блокера."><select value={form.ownerId} aria-invalid={Boolean(errors.ownerId)} onChange={(event) => update("ownerId", event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field><Field label="Ескалація до" required error={errors.escalationToId} hint="Кому передається питання, якщо відповідальний не може усунути блокер самостійно."><select value={form.escalationToId} aria-invalid={Boolean(errors.escalationToId)} onChange={(event) => update("escalationToId", event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field><Field wide label="Рекомендація" hint="Конкретне рішення, яке пропонує відповідальний."><textarea value={form.recommendation} onChange={(event) => update("recommendation", event.target.value)} placeholder="Наприклад: погодити варіант А або призначити іншого редактора" /></Field><Field wide label="Наслідок без рішення" hint="Що станеться зі строком, результатом або пов’язаними завданнями без реакції."><textarea value={form.impact} onChange={(event) => update("impact", event.target.value)} placeholder="Наприклад: публікація зміститься щонайменше на 3 дні" /></Field><Field label="Рішення потрібне до" required error={errors.decisionDue} hint="Гранична дата реакції до настання суттєвого наслідку."><input type="date" value={form.decisionDue} aria-invalid={Boolean(errors.decisionDue)} onChange={(event) => update("decisionDue", event.target.value)} /></Field></div></ModalShell>;
}

function DecisionModal({ node, users, notify, close, save }: { node: WorkNode; users: PortalUser[]; notify: Notify; close: () => void; save: (decision: Decision) => void }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:decision-draft:${node.id}`, { question: "", options: "", recommendation: "", decisionOwnerId: node.ownerId, dueDate: node.plannedEnd });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (key: keyof typeof form, value: string) => { setErrors((current) => ({ ...current, [key]: "" })); setForm({ ...form, [key]: value }); };
  const submit = () => { const next = { question: !form.question.trim() ? "Сформулюйте одне рішення, яке потрібно прийняти." : "", decisionOwnerId: !form.decisionOwnerId ? "Оберіть уповноважену особу." : "", dueDate: !form.dueDate ? "Вкажіть строк рішення." : "" }; const active = Object.fromEntries(Object.entries(next).filter(([, value]) => value)); if (Object.keys(active).length) { setErrors(active); notify("Не вдалося надіслати запит рішення: перевірте виділені поля.", "error"); focusFirstError(); return; } clearDraft(); save({ id: crypto.randomUUID(), nodeId: node.id, ...form, resolution: "", status: "requested", createdAt: isoNow(), decidedAt: "" }); };
  return <ModalShell title={`Запит рішення · ${node.code}`} subtitle="Управлінська ескалація" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Надіслати запит</button></>}><div className="form-grid"><Field wide label="Питання" required error={errors.question} hint="Одне чітке питання, яке потребує управлінського вибору." example="Чи погоджуємо публікацію варіанта А без нового відео?"><textarea value={form.question} aria-invalid={Boolean(errors.question)} onChange={(event) => update("question", event.target.value)} placeholder="Наприклад: який із двох варіантів затверджуємо?" /></Field><Field wide label="Варіанти" hint="Перелічіть реальні альтернативи та короткий наслідок кожної."><textarea value={form.options} onChange={(event) => update("options", event.target.value)} placeholder="Варіант А — ...; варіант Б — ..." /></Field><Field wide label="Рекомендація" hint="Який варіант ви рекомендуєте та чому."><textarea value={form.recommendation} onChange={(event) => update("recommendation", event.target.value)} placeholder="Рекомендую варіант А, тому що…" /></Field><Field label="Хто вирішує" required error={errors.decisionOwnerId} hint="Особа з повноваженням прийняти це рішення."><select value={form.decisionOwnerId} aria-invalid={Boolean(errors.decisionOwnerId)} onChange={(event) => update("decisionOwnerId", event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field><Field label="Строк рішення" required error={errors.dueDate} hint="Дата, до якої рішення ще дозволяє зберегти план або мінімізувати наслідки."><input type="date" value={form.dueDate} aria-invalid={Boolean(errors.dueDate)} onChange={(event) => update("dueDate", event.target.value)} /></Field></div></ModalShell>;
}

function CoordinationModal({ node, payload, notify, close, save }: { node: WorkNode; payload: PortalPayload; notify: Notify; close: () => void; save: (snapshot: CoordinationSnapshot) => void }) {
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:coordination-draft:${node.id}`, { summary: "", agreements: "" });
  const { summary, agreements } = form;
  const [summaryError, setSummaryError] = useState("");
  const tasks = node.kind === "cycle" ? payload.nodes.filter((item) => item.kind === "task" && item.parentId === node.id && !item.archived) : descendants(payload.nodes, node.id).filter((item) => item.kind === "task");
  const submit = () => { if (!summary.trim()) { setSummaryError("Зафіксуйте висновок координації та потрібну управлінську увагу."); notify("Не вдалося зберегти координацію: заповніть виділене поле.", "error"); focusFirstError(); return; } clearDraft(); save({ id: crypto.randomUUID(), subcycleId: node.id, date: isoNow().slice(0, 10), facilitatorId: payload.currentUser.id, summary, agreements, taskState: tasks.map((task) => ({ nodeId: task.id, lifecycle: task.lifecycle, health: task.health, plannedEnd: task.plannedEnd, progress: task.progress })), blockerIds: payload.blockers.filter((item) => item.status === "open" && tasks.some((task) => task.id === item.nodeId)).map((item) => item.id), decisionIds: payload.decisions.filter((item) => item.status === "requested" && tasks.some((task) => task.id === item.nodeId)).map((item) => item.id), createdAt: isoNow() }); };
  return <ModalShell title={`Координація ${node.code}`} subtitle="Незмінний знімок фактичного стану" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Зберегти знімок</button></>}><div className="snapshot-preview"><strong>До знімка потраплять</strong><span>{tasks.length} завдань</span><span>{tasks.filter((task) => task.health === "blocked").length} заблоковано</span><span>{tasks.filter((task) => task.lifecycle === "acceptance").length} на прийманні</span></div><div className="form-grid"><Field wide label="Управлінське резюме" required error={summaryError} hint="Короткий висновок зі стану одиниці координації: результат, відхилення, блокери та потрібна увага." example="2 із 4 завдань завершено; база знань заблокована; потрібне рішення щодо автора до 16.08."><textarea value={summary} aria-invalid={Boolean(summaryError)} onChange={(event) => { setForm({ ...form, summary: event.target.value }); setSummaryError(""); }} placeholder="Наприклад: що виконано, що відхилено і що потребує уваги" /></Field><Field wide label="Погоджені дії та рішення" hint="Фіксуйте домовленість як: хто — що робить — до якого строку." example="Валентина до 18.08 готує макет; Володимир того ж дня погоджує."><textarea value={agreements} onChange={(event) => setForm({ ...form, agreements: event.target.value })} placeholder="Наприклад: відповідальний — дія — строк" /></Field></div></ModalShell>;
}

function DependencyModal({ node, payload, notify, close, save }: { node: WorkNode; payload: PortalPayload; notify: Notify; close: () => void; save: (dependency: Dependency) => void }) {
  const reaches = (from: string, target: string) => {
    const visited = new Set<string>(); const queue = [from];
    while (queue.length) { const current = queue.shift()!; if (current === target) return true; if (visited.has(current)) continue; visited.add(current); queue.push(...payload.dependencies.filter((item) => item.predecessorId === current).map((item) => item.successorId)); }
    return false;
  };
  const candidates = payload.nodes.filter((item) => item.kind === "task" && item.id !== node.id && !item.archived && !reaches(node.id, item.id) && !payload.dependencies.some((dependency) => dependency.predecessorId === item.id && dependency.successorId === node.id));
  const [form, setForm, clearDraft] = usePersistentDraft(`portal:dependency-draft:${node.id}`, { predecessorId: candidates[0]?.id || "", type: "finish_start" as Dependency["type"] });
  const { predecessorId, type } = form;
  const [error, setError] = useState("");
  const submit = () => { if (!predecessorId) { setError("Немає вибраного допустимого попереднього завдання."); notify("Не вдалося додати залежність: перевірте виділене поле.", "error"); focusFirstError(); return; } clearDraft(); save({ id: crypto.randomUUID(), predecessorId, successorId: node.id, type, createdAt: isoNow() }); };
  return <ModalShell title={`Залежність для ${node.code}`} subtitle="Мережа виконання" close={close} footer={<><button onClick={close}>Скасувати</button><button className="primary" onClick={submit}>Додати залежність</button></>}><div className="form-grid"><Field wide label="Попереднє завдання" required error={error} hint="Завдання, від події якого залежить початок або завершення поточного завдання."><select value={predecessorId} aria-invalid={Boolean(error)} onChange={(event) => { setForm({ ...form, predecessorId: event.target.value }); setError(""); }}>{candidates.length ? candidates.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>) : <option value="">Немає допустимих завдань</option>}</select></Field><Field wide label="Тип залежності" required hint="Визначає, яка подія попередника дозволяє або обмежує подію поточного завдання."><select value={type} onChange={(event) => setForm({ ...form, type: event.target.value as Dependency["type"] })}><option value="finish_start">Завершення → початок</option><option value="start_start">Початок → початок</option><option value="finish_finish">Завершення → завершення</option><option value="start_finish">Початок → завершення</option></select></Field></div></ModalShell>;
}

function EvidenceModal({ node, currentUser, notify, close, save }: { node: WorkNode; currentUser: PortalUser; notify: Notify; close: () => void; save: (evidence: Evidence) => void }) {
  const [draft, setDraft, clearDraft] = usePersistentDraft(`portal:evidence-draft:${node.id}`, { kind: "link" as Evidence["kind"], label: "", value: "" });
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
