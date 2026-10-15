import type { SessionId, Usage } from "./schemas";

/** Host UI projection, never an additional model tool or permission grant. */
export interface TaskView {
  readonly id: string;
  readonly kind: "agent" | "command";
  readonly sessionId: SessionId;
  readonly title: string;
  readonly status: string;
  readonly active: boolean;
  readonly controllable: boolean;
  readonly historical: boolean;
  readonly model?: string;
  readonly activity?: string;
  readonly startedAt?: string;
  readonly usage?: Usage;
  readonly exitCode?: number | null;
}
export interface TaskPage {
  readonly tasks: readonly TaskView[];
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly truncated: boolean;
}
export interface TaskDetail {
  readonly task: TaskView;
  readonly content: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly truncated: boolean;
  readonly note?: string;
}
/** Read-only observation must not mark results delivered to the model. */
export interface CommandTaskAccess {
  list(sessionId: SessionId): readonly TaskView[];
  read(sessionId: SessionId, id: string, offset: number, limit: number): TaskDetail | undefined;
  stop(sessionId: SessionId, id: string): Promise<boolean>;
}
export interface TaskService {
  listTasks(parentId: SessionId, offset?: number, limit?: number): Promise<TaskPage>;
  getTask(parentId: SessionId, kind: TaskView["kind"], id: string, offset?: number, limit?: number): Promise<TaskDetail>;
  stopTask(parentId: SessionId, kind: TaskView["kind"], id: string): Promise<boolean>;
}
