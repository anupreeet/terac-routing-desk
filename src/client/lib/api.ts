// Thin fetch wrapper. Errors come back as ApiError with the server's code and body.
import type { ActivityDto, CommandBody, CreateTaskBody, DeliverBody, EventDto, RespondBody, SnapshotDto, TaskDetailDto } from '../../shared/schemas';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
  get task(): TaskDetailDto | undefined {
    return this.body.task as TaskDetailDto | undefined;
  }
  get unseen(): EventDto[] {
    return (this.body.unseen as EventDto[] | undefined) ?? [];
  }
}

export interface Timed<T> {
  data: T;
  sentAt: number;
  receivedAt: number;
}

const UNREACHABLE = 'Can’t reach the desk server.';

/** The request never got an answer from the desk: the network failed, or a proxy in front of it said it's down. */
export function isUnreachable(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'network' || err.code === 'unreachable');
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', UNREACHABLE, {});
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  let parsed = true;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    parsed = false;
  }
  // A gateway error without the desk's own error body (e.g. the dev proxy while the API is down) means the
  // desk never saw the request. Say that, not "Request failed (502)".
  if ((res.status === 502 || res.status === 503 || res.status === 504) && !(parsed && json.error)) throw new ApiError(res.status, 'unreachable', UNREACHABLE, {});
  if (!parsed) throw new ApiError(res.status, 'bad_response', `Unexpected response from the server (${res.status}).`, {});
  if (!res.ok) {
    const err = (json.error ?? {}) as Record<string, unknown>;
    throw new ApiError(res.status, String(err.code ?? 'error'), String(err.message ?? `Request failed (${res.status})`), err);
  }
  return json as T;
}

export const api = {
  async snapshot(): Promise<Timed<SnapshotDto>> {
    const sentAt = Date.now();
    const data = await call<SnapshotDto>('GET', '/api/snapshot');
    return { data, sentAt, receivedAt: Date.now() };
  },
  task: (id: number) => call<TaskDetailDto>('GET', `/api/tasks/${id}`),
  activity: (limit: number, before?: number) => call<ActivityDto>('GET', `/api/activity?limit=${limit}${before ? `&before=${before}` : ''}`),
  createTask: (body: CreateTaskBody) => call<{ task: TaskDetailDto }>('POST', '/api/tasks', body),
  command: (id: number, body: CommandBody) => call<{ task: TaskDetailDto }>('POST', `/api/tasks/${id}/commands`, body),
  respond: (assignmentId: number, body: RespondBody) => call<{ task: TaskDetailDto }>('POST', `/api/sim/assignments/${assignmentId}/respond`, body),
  deliver: (attemptId: number, body: DeliverBody) => call<{ applied: boolean; reason: string | null; task: TaskDetailDto }>('POST', `/api/sim/attempts/${attemptId}/deliver`, body),
  setAvailability: (contributorId: number, availability: 'available' | 'away') => call<{ ok: true }>('PATCH', `/api/sim/contributors/${contributorId}`, { availability }),
  reset: () => call<{ ok: true }>('POST', '/api/sim/reset'),
};
