<script lang="ts">
  // Orchestrator component. Subscribes to timer events, owns keyboard listener,
  // and renders TimerDial + TimerDisplay + TimerFooter.
  import { onMount } from 'svelte';
  import {
    timerToggle,
    timerRestartRound,
    timerSkip,
    getTimerState,
    onTimerTick,
    onTimerPaused,
    onTimerResumed,
    onRoundChange,
    onTimerReset,
    onTimerStarted,
    onTimerCompleted,
  } from '$lib/ipc';
  import { timerState } from '$lib/stores/timer';
  import { settings } from '$lib/stores/settings';
  import { overlaySnapEnabled, loadOverlaySnapping, setOverlaySnapping } from '$lib/stores/overlay';
  import { timerPhase } from '$lib/utils/timerPhase';
  import type { RoundType } from '$lib/types';
  import { fade } from 'svelte/transition';
  import TimerDial from './TimerDial.svelte';
  import TimerDisplay from './TimerDisplay.svelte';
  import TimerFooter from './TimerFooter.svelte';
  import MiniControls from './MiniControls.svelte';
  import Tooltip from './Tooltip.svelte';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { listen } from '@tauri-apps/api/event';
  import * as m from '$paraglide/messages.js';
  import { notificationShow, appExit, setSetting } from '$lib/ipc';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { Menu, MenuItem, CheckMenuItem, Submenu, PredefinedMenuItem } from '@tauri-apps/api/menu';
  import { error as logError } from '@tauri-apps/plugin-log';
  import { LogicalPosition } from '@tauri-apps/api/dpi';

  interface Props {
    isCompact?: boolean;
    uiScale?: number;
    overlay?: boolean;
    onResetPosition?: () => Promise<void>;
  }

  let { isCompact = false, uiScale = 1, overlay = false, onResetPosition }: Props = $props();

  let timerSnapshot = $derived($timerState);
  let overlayOpacity = $state(45);
  let overlayPositionLocked = $state(false);
  let pendingDrag: { x: number; y: number; pointer: number; element: HTMLElement } | null = null;
  let lastDragAt = -Infinity;
  let completedRound = $state<RoundType | null>(null);
  let completedTimer: ReturnType<typeof setTimeout> | undefined;
  let reminderPulse = $state(false);
  let reminderTimer: ReturnType<typeof setTimeout> | undefined;
  const phaseLabels = { idle: '未启动', running: '运行中', paused: '已暂停', completed: '已完成' };
  let currentPhase = $derived(timerPhase(timerSnapshot));
  let indicatorPhase = $derived(completedRound ? 'completed' : currentPhase);

  function triggerReminder(preview = false) {
    if (!preview && !$settings.visual_reminders_enabled) return;
    clearTimeout(reminderTimer);
    reminderPulse = true;
    reminderTimer = setTimeout(() => {
      reminderPulse = false;
    }, 4200);
  }

  function roundColor(rt: string): string {
    if (rt === 'work') return 'var(--color-focus-round)';
    if (rt === 'short-break') return 'var(--color-short-round)';
    return 'var(--color-long-round)';
  }

  function roundLabel(rt: string): string {
    if (rt === 'work') return m.round_label_work();
    if (rt === 'short-break') return m.round_label_short_break();
    return m.round_label_long_break();
  }

  function startOverlayDrag(event: PointerEvent) {
    const target = event.target;
    if (
      event.button !== 0 ||
      event.detail > 1 ||
      overlayPositionLocked ||
      (target instanceof Element && target.closest('button'))
    )
      return;
    const element = event.currentTarget as HTMLElement;
    pendingDrag = { x: event.clientX, y: event.clientY, pointer: event.pointerId, element };
    element.setPointerCapture(event.pointerId);
  }

  function cancelOverlayDrag() {
    if (pendingDrag?.element.hasPointerCapture(pendingDrag.pointer)) {
      pendingDrag.element.releasePointerCapture(pendingDrag.pointer);
    }
    pendingDrag = null;
  }

  function moveOverlayDrag(event: PointerEvent) {
    if (!pendingDrag || event.pointerId !== pendingDrag.pointer) return;
    if (!(event.buttons & 1) || overlayPositionLocked || !overlay) {
      cancelOverlayDrag();
      return;
    }
    if (Math.hypot(event.clientX - pendingDrag.x, event.clientY - pendingDrag.y) < 4) return;
    cancelOverlayDrag();
    lastDragAt = performance.now();
    void getCurrentWebviewWindow()
      .startDragging()
      .catch((e) => logError(`[mini] drag failed: ${String(e)}`));
  }

  function handleOverlayDoubleClick(event: MouseEvent) {
    if (
      event.button !== 0 ||
      performance.now() - lastDragAt < 400 ||
      (event.target instanceof Element && event.target.closest('button'))
    )
      return;
    restoreFullWindow();
  }

  async function openOverlayMenu(event: MouseEvent) {
    event.preventDefault();
    cancelOverlayDrag();
    const menu = await Menu.new({
      items: [
        await MenuItem.new({
          text: `${roundLabel(timerSnapshot.round_type)} · ${timerSnapshot.work_round_number}/${timerSnapshot.work_rounds_total}`,
          enabled: false,
        }),
        await MenuItem.new({ text: `状态：${phaseLabels[currentPhase]}`, enabled: false }),
        ...(completedRound
          ? [
              await MenuItem.new({
                text: `上一轮已完成：${roundLabel(completedRound)}`,
                enabled: false,
              }),
            ]
          : []),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({ text: '重置当前轮次', action: () => timerRestartRound() }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await CheckMenuItem.new({
          text: '窗口置顶',
          checked: $settings.always_on_top,
          action: () =>
            void setSetting('always_on_top', String(!$settings.always_on_top)).catch((e) =>
              logError(String(e))
            ),
        }),
        await Submenu.new({
          text: '背景透明度',
          items: await Promise.all(
            [0, 25, 40, 55, 70].map((transparency) =>
              CheckMenuItem.new({
                text: transparency === 0 ? '不透明' : `${transparency}%`,
                checked: overlayOpacity === 100 - transparency,
                action: () => setOverlayOpacity(100 - transparency),
              })
            )
          ),
        }),
        await CheckMenuItem.new({
          text: '锁定位置',
          checked: overlayPositionLocked,
          action: () => toggleOverlayPositionLock(),
        }),
        await CheckMenuItem.new({
          text: '边缘磁吸',
          checked: $overlaySnapEnabled,
          action: () => setOverlaySnapping(!$overlaySnapEnabled),
        }),
        await MenuItem.new({
          text: '重置窗口位置',
          enabled: !overlayPositionLocked && !!onResetPosition,
          action: () =>
            void onResetPosition?.().catch((e) =>
              logError(`[mini] position reset failed: ${String(e)}`)
            ),
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({
          text: '恢复主窗口',
          action: restoreFullWindow,
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({ text: '退出', action: () => void appExit() }),
      ],
    });
    await menu.popup(new LogicalPosition(event.clientX, event.clientY), getCurrentWebviewWindow());
  }

  function setOverlayOpacity(value: number) {
    overlayOpacity = value;
    localStorage.setItem('pomotroid-overlay-opacity', String(overlayOpacity));
  }

  function restoreFullWindow() {
    cancelOverlayDrag();
    void setSetting('mini_mode', 'false').catch((e) =>
      logError(`[mini] restore failed: ${String(e)}`)
    );
  }

  function toggleOverlayPositionLock() {
    overlayPositionLocked = !overlayPositionLocked;
    localStorage.setItem('pomotroid-overlay-position-locked', String(overlayPositionLocked));
  }

  onMount(() => {
    const cleanups: UnlistenFn[] = [];
    loadOverlaySnapping();
    const savedOpacity = Number(localStorage.getItem('pomotroid-overlay-opacity'));
    if ([30, 45, 60, 75, 100].includes(savedOpacity)) overlayOpacity = savedOpacity;
    overlayPositionLocked = localStorage.getItem('pomotroid-overlay-position-locked') === 'true';

    const onEscape = (event: KeyboardEvent) => {
      if (overlay && event.key === 'Escape') restoreFullWindow();
    };
    document.addEventListener('keydown', onEscape);
    cleanups.push(() => document.removeEventListener('keydown', onEscape));
    document.addEventListener('pointermove', moveOverlayDrag);
    document.addEventListener('pointerup', cancelOverlayDrag);
    document.addEventListener('pointercancel', cancelOverlayDrag);
    window.addEventListener('blur', cancelOverlayDrag);
    cleanups.push(() => {
      cancelOverlayDrag();
      document.removeEventListener('pointermove', moveOverlayDrag);
      document.removeEventListener('pointerup', cancelOverlayDrag);
      document.removeEventListener('pointercancel', cancelOverlayDrag);
      window.removeEventListener('blur', cancelOverlayDrag);
    });

    // Async setup: hydrate state and register event listeners.
    (async () => {
      const initial = await getTimerState();
      timerState.set(initial);

      cleanups.push(
        await listen('reminder:preview', () => triggerReminder(true)),
        await onTimerStarted(({ total_secs }) => {
          timerState.update((s) => ({
            ...s,
            elapsed_secs: 0,
            total_secs,
            is_running: true,
            is_paused: false,
          }));
        }),
        await onTimerCompleted(({ round_type, skipped }) => {
          clearTimeout(completedTimer);
          completedRound = skipped ? null : round_type;
          if (!skipped) {
            triggerReminder();
            completedTimer = setTimeout(() => {
              completedRound = null;
            }, 2000);
          }
        }),
        await onTimerTick(({ elapsed_secs, total_secs }) => {
          timerState.update((s) => ({
            ...s,
            elapsed_secs,
            total_secs,
            is_running: true,
            is_paused: false,
          }));
        }),
        await onTimerPaused(({ elapsed_secs }) => {
          timerState.update((s) => ({
            ...s,
            elapsed_secs,
            is_running: false,
            is_paused: true,
          }));
        }),
        await onTimerResumed(({ elapsed_secs }) => {
          timerState.update((s) => ({
            ...s,
            elapsed_secs,
            is_running: true,
            is_paused: false,
          }));
        }),
        await onRoundChange((snap) => {
          timerState.set(snap);
          if ($settings.notifications_enabled) {
            let title: string;
            let body: string;
            if (snap.round_type === 'work') {
              const afterBreak =
                snap.previous_round_type === 'short-break' ||
                snap.previous_round_type === 'long-break';
              title = afterBreak ? m.notification_work_title() : m.notification_work_start_title();
              body = afterBreak ? m.notification_work_body() : m.notification_work_start_body();
            } else if (snap.round_type === 'short-break') {
              title = m.notification_short_break_title();
              body = m.notification_short_break_body();
            } else {
              title = m.notification_long_break_title();
              body = m.notification_long_break_body();
            }
            notificationShow(title, body).catch(() => {});
          }
        }),
        await onTimerReset((snap) => {
          clearTimeout(completedTimer);
          clearTimeout(reminderTimer);
          reminderPulse = false;
          completedRound = null;
          timerState.set(snap);
        })
      );
    })();

    return () => {
      clearTimeout(completedTimer);
      clearTimeout(reminderTimer);
      for (const unlisten of cleanups) unlisten();
    };
  });
</script>

<div class="timer-outer" class:compact={isCompact} class:overlay class:reminder-pulse={reminderPulse}>
  {#if reminderPulse && !overlay}
    <span class="reminder-badge" role="status" aria-live="assertive">{m.reminder_time_up()}</span>
  {/if}
  {#if overlay}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="overlay-row"
      class:position-locked={overlayPositionLocked}
      onpointerdown={startOverlayDrag}
      oncontextmenu={(event) =>
        void openOverlayMenu(event).catch((e) => logError(`[mini] menu failed: ${String(e)}`))}
      ondblclick={handleOverlayDoubleClick}
      style="--overlay-opacity: {overlayOpacity}%"
      role="application"
      aria-label="迷你计时窗口"
    >
      <span
        class="overlay-status"
        class:idle={indicatorPhase === 'idle'}
        class:running={indicatorPhase === 'running'}
        style="--status-color: {roundColor(completedRound ?? timerSnapshot.round_type)}"
        aria-label={completedRound
          ? `上一轮已完成：${roundLabel(completedRound)}`
          : `${roundLabel(timerSnapshot.round_type)}：${phaseLabels[currentPhase]}`}
      >
        {#if indicatorPhase === 'paused'}
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <rect x="1" y="1" width="2" height="6" fill="currentColor" />
            <rect x="5" y="1" width="2" height="6" fill="currentColor" />
          </svg>
        {:else if indicatorPhase === 'completed'}
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            <path d="M1 4 L3 6 L7 2" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        {/if}
      </span>
      <div
        class="overlay-time"
        class:paused={currentPhase === 'paused'}
        class:idle={currentPhase === 'idle'}
      >
        <TimerDisplay state={timerSnapshot} />
      </div>
      <MiniControls />
    </div>
  {:else}
    <div class="timer" style="zoom: {uiScale}">
      <!-- Dial + display stacked (display centered over dial) -->
      <div class="dial-stack">
        <TimerDial snap={timerSnapshot} countdown={$settings.dial_countdown} />
        <TimerDisplay state={timerSnapshot} />
      </div>

      {#if !isCompact}
        <!-- Round type label sits below the dial as a normal flex child so it
           does not affect the dial-stack height used to centre TimerDisplay. -->
        <div class="round-label" style="color: {roundColor(timerSnapshot.round_type)}">
          {roundLabel(timerSnapshot.round_type)}
        </div>

        <div class="controls-wrapper">
          <!-- Back: restart current round -->
          <Tooltip text={m.tooltip_restart_round()}>
            <button class="btn-side" onclick={timerRestartRound} aria-label="Restart round">
              <svg width="18" height="18" viewBox="0 0 16 16">
                <polygon points="15,1 6,8 15,15" fill="currentColor" />
                <rect x="1" y="1" width="3" height="14" rx="1" fill="currentColor" />
              </svg>
            </button>
          </Tooltip>

          <!-- Play / Pause — icon fades when state changes -->
          <button
            class="play-pause"
            onclick={timerToggle}
            aria-label={timerSnapshot.is_running ? 'Pause' : 'Play'}
          >
            {#key timerSnapshot.is_running}
              <span class="icon" in:fade={{ duration: 120 }}>
                {#if timerSnapshot.is_running}
                  <svg width="24" height="24" viewBox="0 0 24 24">
                    <rect x="5" y="3" width="5" height="18" rx="1.5" fill="currentColor" />
                    <rect x="14" y="3" width="5" height="18" rx="1.5" fill="currentColor" />
                  </svg>
                {:else}
                  <svg width="18" height="18" viewBox="0 0 24 24" style="overflow: visible;">
                    <polygon points="4,0 28,12 4,24" fill="currentColor" />
                  </svg>
                {/if}
              </span>
            {/key}
          </button>

          <!-- Skip: advance to next round -->
          <Tooltip text={m.tooltip_skip()}>
            <button class="btn-side" onclick={timerSkip} aria-label="Skip round">
              <svg width="18" height="18" viewBox="0 0 16 16">
                <polygon points="1,1 10,8 1,15" fill="currentColor" />
                <rect x="12" y="1" width="3" height="14" rx="1" fill="currentColor" />
              </svg>
            </button>
          </Tooltip>

          <TimerFooter snap={timerSnapshot} />
        </div>
      {/if}
    </div>
  {/if}

  {#if isCompact && !overlay}
    <MiniControls />
  {/if}
</div>

<style>
  .timer-outer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    position: relative;
  }

  .reminder-badge {
    position: absolute;
    top: -18px;
    z-index: 3;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--color-accent);
    color: var(--color-background);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    pointer-events: none;
  }

  .reminder-pulse .dial-stack,
  .reminder-pulse .overlay-row {
    animation: reminder-flash 0.7s ease-in-out 4;
  }

  @keyframes reminder-flash {
    0%, 100% { filter: none; }
    50% { filter: brightness(1.6); }
  }

  @media (prefers-reduced-motion: reduce) {
    .reminder-pulse .dial-stack,
    .reminder-pulse .overlay-row {
      animation: none;
      box-shadow: inset 0 0 0 2px var(--color-accent);
    }
  }

  .timer-outer.overlay {
    width: 100%;
    height: 100%;
    justify-content: center;
    cursor: move;
  }

  .overlay-time {
    position: relative;
    width: 86px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .overlay-row {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background-color: color-mix(
      in srgb,
      var(--color-background) var(--overlay-opacity),
      transparent
    );
    border-radius: 8px;
    cursor: move;
    touch-action: none;
    overflow: hidden;
  }

  .overlay-row.position-locked {
    cursor: default;
  }
  .overlay-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--status-color);
  }
  .overlay-status.running {
    background: var(--status-color);
  }
  .overlay-status.idle {
    box-shadow: inset 0 0 0 1px var(--status-color);
  }
  .overlay-time.idle {
    opacity: 0.75;
  }
  .overlay-time.paused {
    opacity: 0.6;
  }

  .overlay-time :global(.time) {
    font-size: 1rem;
  }

  .overlay-row :global(.mini-controls) {
    gap: 2px;
  }

  .overlay-row :global(.btn-side),
  .overlay-row :global(.play-pause) {
    width: 16px;
    height: 16px;
  }

  .overlay-row :global(.play-pause) {
    border-width: 1px;
  }

  .timer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .dial-stack {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .controls-wrapper {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px 12px;
  }
  .controls-wrapper > :global(*) {
    aspect-ratio: 1;
  }

  .btn-side {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-foreground-darker, var(--color-foreground));
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 4px;
    transition:
      color var(--transition-default),
      background var(--transition-default);
  }

  .btn-side:hover {
    color: var(--color-foreground);
    background: var(--color-hover);
  }

  .play-pause {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-foreground);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 2px solid var(--color-foreground-darker, var(--color-foreground));
    transition:
      color var(--transition-default),
      border-color var(--transition-default),
      background var(--transition-default);
    overflow: hidden; /* clip the fading icon within the circle */
  }

  .play-pause:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
    background: var(--color-hover);
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .round-label {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    /* Collapse the gap above: the flex gap already provides spacing from the dial. */
    margin-top: -8px;
  }
</style>
