/** An expected refusal (bad state, stale version, ineligible contributor). The HTTP layer maps `status`. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** A guard passed but the write it protected did not happen: a bug. Rolls back and surfaces as a 500. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

export const notFound = (what: string, id: number | string) => new DomainError('not_found', 404, `${what} ${id} not found`);
