// The URL is the UI's state: which page, and which task is open. A refresh or a shared link must land
// in the same place, and junk must never open the wrong task.
import { describe, expect, it } from 'vitest';
import { canonicalPath, pageOf, taskOf } from '../../src/client/lib/router';

describe('pageOf', () => {
  it.each([
    ['/', 'tasks'],
    ['/activity', 'activity'],
    ['/activity/', 'activity'],
    ['/contributors', 'contributors'],
    ['/how-it-works', 'how-it-works'],
  ])('%s → %s', (path, page) => expect(pageOf(path)).toBe(page));

  it.each(['/nope', '/tasks', '/activity/extra', '/CONTRIBUTORS', ''])('unknown path %j falls back to the task list', (path) => expect(pageOf(path)).toBe('tasks'));
});

describe('taskOf', () => {
  it.each([
    ['?task=T-104', 104],
    ['?task=t-104', 104],
    ['?task=104', 104],
    ['?foo=1&task=T-7', 7],
  ])('%s → %d', (search, id) => expect(taskOf(search)).toBe(id));

  it.each(['', '?task=', '?task=T-', '?task=T-0', '?task=-3', '?task=T-1.5', '?task=abc', '?other=T-104'])('%j opens nothing', (search) => expect(taskOf(search)).toBeNull());

  // Number() would read these as 1000, 16, 104, 104: a mistyped link must never open some other task.
  it.each(['?task=T-1e3', '?task=0x10', '?task=T-104x', '?task=%20104', '?task=T-0104', '?task=T-+104', '?task=T-99999999999'])('%j is not a task id', (search) => expect(taskOf(search)).toBeNull());
});

describe('canonicalPath', () => {
  it.each([
    ['/', '/'],
    ['/activity', '/activity'],
    ['/activity/', '/activity'],
    ['/contributors', '/contributors'],
    ['/how-it-works', '/how-it-works'],
    ['/nope', '/'],
    ['/tasks', '/'],
    ['/activity/extra', '/'],
  ])('%s → %s', (path, canonical) => expect(canonicalPath(path)).toBe(canonical));
});
