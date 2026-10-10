// Demo presets for the SIMULATION only. Shown in the create form before a task exists;
// after creation the operator UI never reveals which preset a task has.

export const ENGINE_PRESETS = [
  { id: 'realistic', label: 'Realistic', hint: 'Seeded random: usually 5–20s, sometimes slow, about 1 in 5 never answer.' },
  { id: 'quick_match', label: 'Quick match', hint: 'Every request answers with a match after 6s.' },
  { id: 'late_answer', label: 'Late answer', hint: 'Request #1 answers after 40s; later requests after 6s.' },
  { id: 'lost_once', label: 'Lost once', hint: 'Request #1 never answers; later requests match after 6s.' },
  { id: 'lost_always', label: 'Lost always', hint: 'No request ever answers.' },
  { id: 'no_match', label: 'No match first', hint: 'Request #1 reports no match after 8s; later requests match after 6s.' },
] as const;
export type EnginePreset = (typeof ENGINE_PRESETS)[number]['id'];

export const CONTRIBUTOR_PRESETS = [
  { id: 'manual', label: 'Manual', hint: 'Waits for "Respond as" clicks; otherwise the offer expires.' },
  { id: 'accept', label: 'Accepts', hint: 'Accepts the first offer after 4s.' },
  { id: 'decline', label: 'Declines', hint: 'Declines the first offer after 4s, with a reason.' },
  { id: 'ignore', label: 'Never replies', hint: 'Lets the first offer expire.' },
  { id: 'withdraw_after_accept', label: 'Withdraws after accepting', hint: 'Accepts after 4s, then withdraws before starting at 10s.' },
] as const;
export type ContributorPreset = (typeof CONTRIBUTOR_PRESETS)[number]['id'];
