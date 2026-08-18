import { asanaRequest } from "../../../../lib/asana";
import { currentUser, jsonError, loadState } from "../../../../lib/server";

type AsanaEnvelope<T> = { data?: T };
type Workspace = { gid: string; name: string };
type Task = {
  gid: string;
  name: string;
  completed?: boolean;
  due_on?: string | null;
  modified_at?: string;
  permalink_url?: string;
  assignee?: { gid: string; name: string } | null;
  projects?: Array<{ gid: string; name: string }>;
  workspace?: Workspace;
};

const taskFields = "gid,name,completed,due_on,modified_at,permalink_url,assignee.gid,assignee.name,projects.gid,projects.name,workspace.gid,workspace.name";

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  if (query.length < 2) return jsonError("Введіть щонайменше 2 символи назви", 400);

  try {
    const me = await asanaRequest(user.id, "/users/me?opt_fields=workspaces.name") as AsanaEnvelope<{ workspaces?: Workspace[] }>;
    const workspaces = me.data?.workspaces || [];
    let limitedSearch = false;
    let failedWorkspaces = 0;
    const batches = await Promise.all(workspaces.map(async (workspace) => {
      const searchParams = new URLSearchParams({
        text: query,
        sort_by: "relevance",
        limit: "100",
        opt_fields: taskFields,
      });
      try {
        const result = await asanaRequest(user.id, `/workspaces/${encodeURIComponent(workspace.gid)}/tasks/search?${searchParams}`) as AsanaEnvelope<Task[]>;
        return result.data || [];
      } catch {
        limitedSearch = true;
        const fallbackParams = new URLSearchParams({
          assignee: "me",
          workspace: workspace.gid,
          completed_since: "2000-01-01T00:00:00.000Z",
          limit: "100",
          opt_fields: taskFields,
        });
        try {
          const result = await asanaRequest(user.id, `/tasks?${fallbackParams}`) as AsanaEnvelope<Task[]>;
          return result.data || [];
        } catch {
          failedWorkspaces += 1;
          return [];
        }
      }
    }));
    if (workspaces.length && failedWorkspaces === workspaces.length) throw new Error("Asana не надала доступ до пошуку задач. Перепідключіть особистий Asana-акаунт у налаштуваннях порталу.");
    const normalizedQuery = query.toLocaleLowerCase("uk");
    const unique = new Map<string, Task>();
    for (const task of batches.flat()) {
      if (task.name.toLocaleLowerCase("uk").includes(normalizedQuery)) unique.set(task.gid, task);
    }
    const tasks = [...unique.values()]
      .sort((a, b) => Number(b.name.toLocaleLowerCase("uk").startsWith(normalizedQuery)) - Number(a.name.toLocaleLowerCase("uk").startsWith(normalizedQuery)) || (b.modified_at || "").localeCompare(a.modified_at || ""))
      .slice(0, 30);
    return Response.json({ tasks, limitedSearch, partial: failedWorkspaces > 0 });
  } catch (cause) {
    return jsonError(cause instanceof Error ? cause.message : "Не вдалося знайти завдання Asana", 502);
  }
}
