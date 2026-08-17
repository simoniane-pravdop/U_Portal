export type NodeKind = "goal" | "cycle" | "subcycle" | "task";
export type LifecycleStatus =
  | "draft"
  | "planned"
  | "ready"
  | "in_progress"
  | "acceptance"
  | "completed"
  | "paused"
  | "cancelled";
export type HealthStatus = "normal" | "risk" | "blocked";
export type StartMode = "with_parent" | "manual_capacity" | "fixed_date" | "after_dependency";
export type PortalRole = "owner" | "admin" | "goal_owner" | "cycle_owner" | "coordinator" | "executor" | "viewer";
export type SyncRule = "portal" | "asana" | "manual";

export type PortalUser = {
  id: string;
  name: string;
  email: string;
  role: PortalRole;
  active: boolean;
  color: string;
};

export type Evidence = {
  id: string;
  kind: "link" | "note" | "file";
  label: string;
  value: string;
  createdAt: string;
  createdBy: string;
};

export type WorkUpdate = {
  id: string;
  lifecycle: LifecycleStatus;
  health: HealthStatus;
  progress: number;
  forecastEnd: string;
  summary: string;
  nextAction: string;
  createdAt: string;
  createdBy: string;
  source: "portal" | "asana";
};

export type AsanaLink = {
  taskGid: string;
  taskUrl: string;
  projectGid: string;
  sectionGid: string;
  lastSyncedAt: string | null;
  syncState: "not_linked" | "linked" | "pending" | "conflict" | "error";
  rules: {
    title: SyncRule;
    assignee: SyncRule;
    dates: SyncRule;
    status: SyncRule;
    description: SyncRule;
  };
};

export type Recurrence = {
  enabled: boolean;
  frequency: "weekly" | "monthly" | "quarterly" | "yearly";
  interval: number;
  nextDate: string;
};

export type WorkNode = {
  id: string;
  parentId: string | null;
  code: string;
  kind: NodeKind;
  title: string;
  description: string;
  result: string;
  nonResult: string;
  acceptanceCriteria: string;
  ownerId: string;
  assigneeId: string;
  acceptorId: string;
  participantIds: string[];
  lifecycle: LifecycleStatus;
  health: HealthStatus;
  decisionRequired: boolean;
  priority: "critical" | "high" | "normal" | "low";
  plannedStart: string;
  plannedEnd: string;
  forecastEnd: string;
  actualStart: string;
  actualEnd: string;
  progress: number;
  weight: number;
  startMode: StartMode;
  resource: string;
  authority: string;
  coordinationCadence: string;
  controlPlace: string;
  visibility: "company" | "participants";
  archived: boolean;
  evidence: Evidence[];
  updates?: WorkUpdate[];
  recurrence: Recurrence;
  asana: AsanaLink;
  createdAt: string;
  updatedAt: string;
};

export type Dependency = {
  id: string;
  predecessorId: string;
  successorId: string;
  type: "finish_start" | "start_start" | "finish_finish" | "start_finish";
  createdAt: string;
};

export type Blocker = {
  id: string;
  nodeId: string;
  title: string;
  facts: string;
  cause: string;
  actionsTaken: string;
  ownerId: string;
  escalationToId: string;
  recommendation: string;
  impact: string;
  decisionDue: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string;
};

export type Decision = {
  id: string;
  nodeId: string;
  question: string;
  options: string;
  recommendation: string;
  decisionOwnerId: string;
  dueDate: string;
  resolution: string;
  status: "requested" | "decided";
  createdAt: string;
  decidedAt: string;
};

export type Acceptance = {
  id: string;
  nodeId: string;
  submittedBy: string;
  acceptorId: string;
  evidenceNote: string;
  status: "submitted" | "accepted" | "returned";
  feedback: string;
  submittedAt: string;
  decidedAt: string;
  attempt: number;
};

export type CoordinationSnapshot = {
  id: string;
  subcycleId: string;
  date: string;
  facilitatorId: string;
  summary: string;
  agreements: string;
  taskState: Array<{
    nodeId: string;
    lifecycle: LifecycleStatus;
    health: HealthStatus;
    plannedEnd: string;
    progress: number;
  }>;
  blockerIds: string[];
  decisionIds: string[];
  createdAt: string;
};

export type DiscussionMessage = {
  id: string;
  nodeId: string;
  authorId: string;
  text: string;
  kind: "comment" | "question" | "approval" | "system";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

export type EditingLock = {
  entityId: string;
  userId: string;
  userName: string;
  acquiredAt: string;
  expiresAt: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  by: string;
  action: string;
  entityId: string;
};

export type PortalState = {
  version: number;
  revision: number;
  users: PortalUser[];
  nodes: WorkNode[];
  dependencies: Dependency[];
  blockers: Blocker[];
  decisions: Decision[];
  acceptances: Acceptance[];
  coordinations: CoordinationSnapshot[];
  discussions: DiscussionMessage[];
  audit: AuditEntry[];
  settings: {
    organizationName: string;
    allowedGoogleDomain: string;
    timezone: string;
    asanaNotifications: boolean;
    telegramPlanned: boolean;
    recurrencePrepared: boolean;
  };
};

export type SessionUser = PortalUser & {
  authMode: "password" | "google" | "platform";
};

export type PortalPayload = PortalState & {
  currentUser: SessionUser;
  storage: "database" | "memory";
  authConfigured: boolean;
};
