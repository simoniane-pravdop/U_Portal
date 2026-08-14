import { asanaRequest } from "../../../lib/asana";
import { currentUser, jsonError, loadState } from "../../../lib/server";

type AsanaEnvelope<T> = { data?: T };
type Workspace = { gid: string; name: string };
type Project = { gid: string; name: string; workspace?: Workspace };

export async function GET(request: Request) {
  const { state } = await loadState();
  const user = await currentUser(request, state);
  if (!user) return jsonError("Потрібен вхід", 401);
  try {
    const me = await asanaRequest(user.id, "/users/me?opt_fields=workspaces.name") as AsanaEnvelope<{ workspaces?: Workspace[] }>;
    const workspaces = me.data?.workspaces || [];
    const batches = await Promise.all(workspaces.map(async (workspace) => {
      const response = await asanaRequest(user.id, `/projects?workspace=${encodeURIComponent(workspace.gid)}&archived=false&limit=100&opt_fields=name,workspace.name`) as AsanaEnvelope<Project[]>;
      return (response.data || []).map((project) => ({ gid: project.gid, name: project.name, workspace: workspace.name }));
    }));
    return Response.json({ projects: batches.flat().sort((a, b) => a.name.localeCompare(b.name, "uk")) });
  } catch (cause) {
    return jsonError(cause instanceof Error ? cause.message : "Не вдалося отримати проєкти Asana", 502);
  }
}
