import type { TimerState } from '$lib/types';

export type TimerPhase = 'idle' | 'running' | 'paused' | 'completed';

export function timerPhase(state: TimerState): TimerPhase {
  if (state.total_secs > 0 && state.elapsed_secs >= state.total_secs) return 'completed';
  if (state.is_paused) return 'paused';
  return state.is_running ? 'running' : 'idle';
}
