"use client";

import { useCallback, useEffect, useState } from "react";
import { LinkedText } from "./LinkedText";
import type { PortalIdea, PortalUser } from "../types";

type Draft = { id?: string; version?: number; title: string; description: string };
const emptyDraft: Draft = { title: "", description: "" };

export function IdeasView({ user, users, canCreateNode, createNode, notify }: {
  user: PortalUser;
  users: PortalUser[];
  canCreateNode: boolean;
  createNode: (idea: PortalIdea) => void;
  notify: (message: string, tone?: "success" | "error") => void;
}) {
  const draftKey = `portal-idea-draft:${user.id}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const stored = typeof window !== "undefined" && JSON.parse(localStorage.getItem(draftKey) || "null");
      return stored && typeof stored.title === "string" && typeof stored.description === "string" ? stored : emptyDraft;
    } catch { return emptyDraft; }
  });
  const [ideas, setIdeas] = useState<PortalIdea[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/ideas", { cache: "no-store" });
      const result = await response.json() as { ideas?: PortalIdea[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Не вдалося завантажити ідеї");
      if (!result.ideas) throw new Error("Не вдалося завантажити ідеї");
      setIdeas(result.ideas);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не вдалося завантажити ідеї");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    try {
      if (draft.title || draft.description || draft.id) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch { /* Saving the idea itself does not depend on local browser storage. */ }
  }, [draft, draftKey]);

  const mayEdit = (idea: PortalIdea) => idea.createdById === user.id || ["owner", "admin"].includes(user.role);
  const edit = (idea: PortalIdea) => {
    if ((draft.title || draft.description) && !window.confirm("Замінити текст у формі обраною ідеєю? Незбережений текст буде втрачено.")) return;
    setDraft({ id: idea.id, version: idea.version, title: idea.title, description: idea.description });
    setFormError("");
    document.getElementById("idea-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("idea-title")?.focus({ preventScroll: true });
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!draft.title.trim()) {
      setFormError("Вкажіть назву ідеї.");
      notify("Вкажіть назву ідеї.", "error");
      document.getElementById("idea-title")?.focus();
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const response = await fetch("/api/ideas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const result = await response.json() as { idea?: PortalIdea; error?: string };
      if (!response.ok) {
        if (response.status === 409) void refresh();
        throw new Error(result.error || "Не вдалося зберегти ідею");
      }
      const saved = result.idea;
      if (!saved) throw new Error("Сервер не підтвердив збереження ідеї");
      setIdeas((current) => [saved, ...current.filter((idea) => idea.id !== saved.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setDraft(emptyDraft);
      notify(draft.id ? "Ідею оновлено." : "Ідею збережено.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не вдалося зберегти ідею";
      setFormError(message);
      notify(message, "error");
    } finally { setSaving(false); }
  };
  const normalizedQuery = query.trim().toLocaleLowerCase("uk-UA");
  const visible = ideas.filter((idea) => `${idea.title} ${idea.description}`.toLocaleLowerCase("uk-UA").includes(normalizedQuery));
  return <div className="ideas-page">
    <header className="ideas-heading"><h1>Ідеї</h1><p>Запишіть задум. Коли він готовий до роботи — створіть на його основі ціль, напрям зусиль, проект або завдання.</p></header>
    <div className="ideas-layout">
      <form id="idea-form" className="panel idea-form" onSubmit={save} noValidate>
        <h2>{draft.id ? "Редагування ідеї" : "Нова ідея"}</h2>
        <label className={`field ${formError && !draft.title.trim() ? "field-error" : ""}`} htmlFor="idea-title"><span>Назва <b className="required-mark">*</b></span><input id="idea-title" value={draft.title} maxLength={250} required aria-invalid={Boolean(formError && !draft.title.trim())} aria-describedby={formError ? "idea-form-error" : undefined} placeholder="Наприклад: автоматизувати щотижневий звіт" disabled={saving} onChange={(event) => { setDraft({ ...draft, title: event.target.value }); setFormError(""); }} /></label>
        <label className="field" htmlFor="idea-description"><span>Опис</span><textarea id="idea-description" value={draft.description} maxLength={12000} rows={6} placeholder="У чому ідея, яку проблему вирішує та що можна зробити?" disabled={saving} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        {formError && <p id="idea-form-error" className="idea-error" role="alert">{formError}</p>}
        <div className="idea-actions"><button type="submit" className="primary" disabled={saving}>{saving ? "Зберігаємо…" : draft.id ? "Зберегти зміни" : "Зберегти ідею"}</button>{draft.id && <button type="button" disabled={saving} onClick={() => { if ((draft.title || draft.description) && !window.confirm("Закрити редагування? Незбережені зміни буде втрачено.")) return; setDraft(emptyDraft); setFormError(""); }}>Скасувати</button>}</div>
        <small className="idea-draft-hint">Незаповнена до кінця форма зберігається в цьому браузері. Після збереження ідея доступна всім учасникам порталу.</small>
      </form>
      <section className="ideas-list" aria-label="Записані ідеї">
        <div className="ideas-list-toolbar"><input id="idea-search" type="search" aria-label="Пошук ідей" placeholder="Пошук за назвою або описом…" value={query} onChange={(event) => setQuery(event.target.value)} /><span>{visible.length} / {ideas.length}</span><button type="button" onClick={() => void refresh()} aria-label="Оновити список ідей" title="Оновити список">↻</button></div>
        {loadError && <p role="alert" className="panel idea-error">{loadError} <button type="button" onClick={() => void refresh()}>Повторити</button></p>}
        {loading ? <p className="panel idea-empty">Завантажуємо ідеї…</p> : !visible.length && <p className="panel idea-empty">{ideas.length ? "За цим запитом ідей немає." : "Ідей поки немає. Запишіть першу у формі."}</p>}
        {visible.map((idea) => <article className="panel idea-card" key={idea.id}>
          <h2>{idea.title}</h2>
          {idea.description && <div className="idea-description"><LinkedText value={idea.description} /></div>}
          <p className="idea-meta">{users.find((item) => item.id === idea.createdById)?.name || "Учасник порталу"} · {new Intl.DateTimeFormat("uk-UA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(idea.createdAt))}</p>
          <div className="idea-actions">{canCreateNode && <button type="button" className="primary" onClick={() => createNode(idea)}>Створити управлінську одиницю →</button>}{mayEdit(idea) && <button type="button" disabled={saving} onClick={() => edit(idea)}>Редагувати ідею</button>}</div>
          {!canCreateNode && <small>Створення управлінських одиниць доступне керівникам і адміністраторам.</small>}
        </article>)}
      </section>
    </div>
  </div>;
}
