// The zod request contract shared by server and client. The server parses every body with these
// schemas, so what they accept is exactly what the API accepts.
import { describe, expect, it } from 'vitest';
import { AvailabilityBody, CommandBody, CreateTaskBody, DeliverBody, RespondBody } from '../../src/shared/schemas';
import { CONTRIBUTOR_ACTIONS, OPERATOR_COMMANDS, PRIORITIES } from '../../src/shared/policy';
import { CONTRIBUTOR_PRESETS, ENGINE_PRESETS } from '../../src/shared/sim-presets';

const ok = (schema: { safeParse(x: unknown): { success: boolean } }, x: unknown) => schema.safeParse(x).success;
const issuesOf = (schema: { safeParse(x: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string; code: string }[] } } }, x: unknown) =>
  schema.safeParse(x).error?.issues ?? [];

describe('CreateTaskBody', () => {
  const minimal = { title: 'Expert call', expertiseId: 'finance' };

  it('fills defaults: empty brief and requester, normal priority, submit immediately, no sim presets', () => {
    expect(CreateTaskBody.parse(minimal)).toEqual({ title: 'Expert call', expertiseId: 'finance', brief: '', requestedBy: '', priority: 'normal', submit: true });
  });

  it('trims the title, brief and requester', () => {
    expect(CreateTaskBody.parse({ ...minimal, title: '   Expert call  ', brief: '  b  ', requestedBy: ' r ' })).toMatchObject({ title: 'Expert call', brief: 'b', requestedBy: 'r' });
  });

  it.each([
    ['abc', true],
    ['ab', false],
    ['  ab  ', false], // trimmed before the length check
    ['', false],
    ['x'.repeat(120), true],
    ['x'.repeat(121), false],
    [`  ${'x'.repeat(120)}  `, true],
  ])('title %j → valid: %s', (title, valid) => {
    expect(ok(CreateTaskBody, { ...minimal, title })).toBe(valid);
  });

  it('explains short and long titles in operator language', () => {
    expect(issuesOf(CreateTaskBody, { ...minimal, title: 'ab' })[0]).toMatchObject({ path: ['title'], message: 'Title needs at least 3 characters' });
    expect(issuesOf(CreateTaskBody, { ...minimal, title: 'x'.repeat(121) })[0]).toMatchObject({ path: ['title'], message: 'Title is limited to 120 characters' });
  });

  it.each([
    [{ title: 123, expertiseId: 'finance' }, 'title'],
    [{ expertiseId: 'finance' }, 'title'],
    [{ title: 'Valid' }, 'expertiseId'],
    [{ title: 'Valid', expertiseId: '' }, 'expertiseId'],
    [{ ...minimal, brief: 'x'.repeat(1001) }, 'brief'],
    [{ ...minimal, requestedBy: 'x'.repeat(121) }, 'requestedBy'],
    [{ ...minimal, priority: 'urgent' }, 'priority'],
    [{ ...minimal, submit: 'true' }, 'submit'],
    [{ ...minimal, sim: { engine: 'psychic' } }, 'sim'],
    [{ ...minimal, sim: { contributor: 'ghost' } }, 'sim'],
  ])('rejects %j at %s', (body, field) => {
    const issues = issuesOf(CreateTaskBody, body);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].path[0]).toBe(field);
  });

  it('an empty expertise says "Choose an expertise area"', () => {
    expect(issuesOf(CreateTaskBody, { title: 'Valid', expertiseId: '' })[0].message).toBe('Choose an expertise area');
  });

  it('accepts a brief of exactly 1000 characters and a requester of exactly 120', () => {
    expect(ok(CreateTaskBody, { ...minimal, brief: 'x'.repeat(1000), requestedBy: 'x'.repeat(120) })).toBe(true);
  });

  it.each([...PRIORITIES])('accepts priority %s', (priority) => {
    expect(CreateTaskBody.parse({ ...minimal, priority }).priority).toBe(priority);
  });

  it('submit: false creates a draft', () => {
    expect(CreateTaskBody.parse({ ...minimal, submit: false }).submit).toBe(false);
  });

  it('rejects unknown top-level keys (.strict)', () => {
    const issues = issuesOf(CreateTaskBody, { ...minimal, status: 'completed' });
    expect(issues[0].code).toBe('unrecognized_keys');
  });

  it.each(ENGINE_PRESETS.map((p) => p.id))('accepts engine preset %s', (engine) => {
    expect(CreateTaskBody.parse({ ...minimal, sim: { engine } }).sim).toEqual({ engine, contributor: 'manual' });
  });

  it.each(CONTRIBUTOR_PRESETS.map((p) => p.id))('accepts contributor preset %s', (contributor) => {
    expect(CreateTaskBody.parse({ ...minimal, sim: { contributor } }).sim).toEqual({ engine: 'realistic', contributor });
  });

  it('an empty sim object defaults to realistic + manual', () => {
    expect(CreateTaskBody.parse({ ...minimal, sim: {} }).sim).toEqual({ engine: 'realistic', contributor: 'manual' });
  });

  it('the sim object is strict too: unknown keys inside it are rejected (a client cannot smuggle in a "fate")', () => {
    expect(CreateTaskBody.safeParse({ ...minimal, sim: { engine: 'quick_match', fate: 'never' } }).success).toBe(false);
    expect(CreateTaskBody.parse({ ...minimal, sim: { engine: 'quick_match' } }).sim).toEqual({ engine: 'quick_match', contributor: 'manual' });
  });
});

describe('CommandBody: one strict shape per operator command', () => {
  const minimalFor = {
    submit: { type: 'submit' },
    offer: { type: 'offer', contributorId: 1 },
    reroute: { type: 'reroute' },
    stop_routing: { type: 'stop_routing' },
    revoke_offer: { type: 'revoke_offer' },
    release: { type: 'release', note: 'No-show' },
    cancel: { type: 'cancel' },
  } as const;

  it('covers every operator command', () => {
    expect(Object.keys(minimalFor).sort()).toEqual([...OPERATOR_COMMANDS].sort());
  });

  describe.each(OPERATOR_COMMANDS.map((c) => [c] as const))('%s', (type) => {
    const base = minimalFor[type];

    it('accepts the minimal body with expectedVersion', () => {
      expect(CommandBody.parse({ ...base, expectedVersion: 3 })).toMatchObject({ ...base, expectedVersion: 3 });
    });

    it('requires expectedVersion', () => {
      expect(issuesOf(CommandBody, base)[0].path).toEqual(['expectedVersion']);
    });

    it.each([-1, 1.5, '2', null])('rejects expectedVersion %j', (v) => {
      expect(ok(CommandBody, { ...base, expectedVersion: v })).toBe(false);
    });

    it('accepts expectedVersion 0 and an optional non-negative seenEventId', () => {
      expect(ok(CommandBody, { ...base, expectedVersion: 0 })).toBe(true);
      expect(ok(CommandBody, { ...base, expectedVersion: 0, seenEventId: 0 })).toBe(true);
      expect(ok(CommandBody, { ...base, expectedVersion: 0, seenEventId: -1 })).toBe(false);
      expect(ok(CommandBody, { ...base, expectedVersion: 0, seenEventId: 2.5 })).toBe(false);
    });

    it('trims the note and caps it at 280 characters', () => {
      expect(CommandBody.parse({ ...base, expectedVersion: 1, note: '  Client asked  ' }).note).toBe('Client asked');
      expect(ok(CommandBody, { ...base, expectedVersion: 1, note: 'x'.repeat(280) })).toBe(true);
      expect(ok(CommandBody, { ...base, expectedVersion: 1, note: 'x'.repeat(281) })).toBe(false);
    });

    it('rejects keys that belong to other commands or to nobody (.strict)', () => {
      const foreign = type === 'offer' ? { reason: 'x' } : { contributorId: 1 };
      expect(issuesOf(CommandBody, { ...base, expectedVersion: 1, ...foreign })[0].code).toBe('unrecognized_keys');
      expect(ok(CommandBody, { ...base, expectedVersion: 1, version: 1 })).toBe(false);
    });
  });

  it('offer needs a positive integer contributorId', () => {
    for (const contributorId of [0, -1, 1.5, '1', null, undefined]) {
      expect(ok(CommandBody, { type: 'offer', contributorId, expectedVersion: 1 }), String(contributorId)).toBe(false);
    }
  });

  it('offer takes an optional boolean acknowledgeExclusion', () => {
    expect(CommandBody.parse({ type: 'offer', contributorId: 2, acknowledgeExclusion: true, expectedVersion: 1 })).toMatchObject({ acknowledgeExclusion: true });
    expect(ok(CommandBody, { type: 'offer', contributorId: 2, acknowledgeExclusion: 'yes', expectedVersion: 1 })).toBe(false);
  });

  it.each([
    [undefined, false],
    ['', false],
    ['   ', false],
    ['x', true],
    ['x'.repeat(280), true],
    ['x'.repeat(281), false],
  ])('release note %j → valid: %s (a reason is required)', (note, valid) => {
    expect(ok(CommandBody, { type: 'release', expectedVersion: 1, ...(note === undefined ? {} : { note }) })).toBe(valid);
  });

  it('release explains the missing reason', () => {
    expect(issuesOf(CommandBody, { type: 'release', expectedVersion: 1, note: ' ' })[0]).toMatchObject({ path: ['note'], message: 'Say why you are releasing this assignment' });
  });

  it.each([{ type: 'delete', expectedVersion: 1 }, { type: 'accept', expectedVersion: 1 }, { expectedVersion: 1 }, {}, null, 'cancel'])('rejects %j (no such command)', (body) => {
    expect(ok(CommandBody, body)).toBe(false);
  });
});

describe('RespondBody', () => {
  it.each([...CONTRIBUTOR_ACTIONS])('accepts %s', (action) => {
    expect(RespondBody.parse({ action })).toEqual({ action });
  });
  it('takes an optional trimmed note of at most 280 characters', () => {
    expect(RespondBody.parse({ action: 'decline', note: '  Conflict  ' })).toEqual({ action: 'decline', note: 'Conflict' });
    expect(ok(RespondBody, { action: 'decline', note: 'x'.repeat(281) })).toBe(false);
  });
  it.each([{ action: 'reject' }, { action: 'release' }, {}, { action: 'accept', assignmentId: 1 }])('rejects %j', (body) => {
    expect(ok(RespondBody, body)).toBe(false);
  });
});

describe('DeliverBody (simulation control)', () => {
  it('a match names a contributor', () => {
    expect(DeliverBody.parse({ outcome: 'match', contributorId: 2 })).toEqual({ outcome: 'match', contributorId: 2 });
  });
  it('a match without a contributor is refused at contributorId', () => {
    expect(issuesOf(DeliverBody, { outcome: 'match' })[0]).toMatchObject({ path: ['contributorId'], message: 'A match needs a contributor' });
  });
  it('a no-match needs nothing else, and tolerates a contributorId', () => {
    expect(ok(DeliverBody, { outcome: 'no_match' })).toBe(true);
    expect(ok(DeliverBody, { outcome: 'no_match', contributorId: 1 })).toBe(true);
  });
  it.each([{ outcome: 'error' }, { outcome: 'never' }, { outcome: 'match', contributorId: 0 }, { outcome: 'match', contributorId: 1, dueAt: 5 }, {}])('rejects %j', (body) => {
    expect(ok(DeliverBody, body)).toBe(false);
  });
});

describe('AvailabilityBody (simulation control)', () => {
  it.each(['available', 'away'])('accepts %s', (availability) => {
    expect(AvailabilityBody.parse({ availability })).toEqual({ availability });
  });
  it.each([{ availability: 'busy' }, { availability: true }, {}, { availability: 'away', maxActive: 3 }])('rejects %j', (body) => {
    expect(ok(AvailabilityBody, body)).toBe(false);
  });
});
