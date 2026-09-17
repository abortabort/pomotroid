<script lang="ts">
  import '../app.css';
  import { onMount, tick } from 'svelte';
  import Titlebar from '$lib/components/Titlebar.svelte';
  import Timer from '$lib/components/Timer.svelte';
  import {
    getSettings,
    getThemes,
    onSettingsChanged,
    onThemesChanged,
    setSetting,
    miniTaskbarReady,
  } from '$lib/ipc';
  import { settings } from '$lib/stores/settings';
  import { applyTheme } from '$lib/stores/theme';
  import { resolveThemeName } from '$lib/utils/theme';
  import { isMac } from '$lib/utils/platform';
  import { setLocale } from '$lib/locale.svelte.js';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { listen } from '@tauri-apps/api/event';
  import { info, error as logError } from '@tauri-apps/plugin-log';
  import { createLocalShortcutHandler } from '$lib/utils/localShortcuts';
  import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
  import { currentMonitor, availableMonitors } from '@tauri-apps/api/window';

  // Local shortcut state — volume and fullscreen tracked separately so the
  // handler can read current values without waiting for settings:changed round-trip.
  let localVolume = $state(1.0);
  let preMuteVolume = $state(0.5);
  let isFullscreen = $state(false);

  // Base window dimensions (natural/default size).
  const BASE_W = 360;
  const BASE_H = 478;
  const TITLEBAR_H = 40;

  // Compact mode: when either dimension drops below this threshold,
  // hide non-essential elements (footer, label, play/pause) to show
  // only the timer dial — like an Apple Watch face.
  const COMPACT_THRESHOLD = 300;

  let uiScale = $state(1.0);
  let isCompact = $state(false);
  let appliedMiniMode: boolean | null = null;
  let requestedMiniMode: boolean | null = null;
  let changingMode = true;
  let geometryTimer: ReturnType<typeof setTimeout> | undefined;
  let geometryRevision = 0;
  let settingsLoaded = $state(false);
  let snapping = false;
  let windowModeUpdates: Promise<void> = Promise.resolve();

  // A small, text-only overlay is easier to keep visible while working.
  const TOP_MODE_W = 160;
  const TOP_MODE_H = 30;
  const NORMAL_SIZE_KEY = 'pomotroid-normal-window-size';
  const NORMAL_GEOMETRY_KEY = 'pomotroid-normal-window-geometry';
  const MINI_GEOMETRY_KEY = 'pomotroid-mini-window-geometry';
  type Geometry = { x: number; y: number; width: number; height: number };

  function readGeometry(mini: boolean): Geometry | null {
    try {
      const value = JSON.parse(
        localStorage.getItem(mini ? MINI_GEOMETRY_KEY : NORMAL_GEOMETRY_KEY) ?? 'null'
      );
      if (
        value &&
        [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
        value.width >= TOP_MODE_W &&
        value.height >= TOP_MODE_H
      )
        return value;
    } catch {
      /* Ignore invalid saved geometry. */
    }
    return null;
  }

  async function saveGeometry(mini: boolean, duringTransition = false) {
    const revision = geometryRevision;
    const win = getCurrentWebviewWindow();
    if ((await win.isMaximized()) || (await win.isFullscreen())) return;
    const position = await win.outerPosition();
    const size = (await win.innerSize()).toLogical(await win.scaleFactor());
    if (
      !duringTransition &&
      (changingMode || revision !== geometryRevision || appliedMiniMode !== mini)
    )
      return;
    if (!mini && size.width <= TOP_MODE_W && size.height <= TOP_MODE_H) return;
    localStorage.setItem(
      mini ? MINI_GEOMETRY_KEY : NORMAL_GEOMETRY_KEY,
      JSON.stringify({ x: position.x, y: position.y, width: size.width, height: size.height })
    );
  }

  function scheduleGeometrySave() {
    if (changingMode || appliedMiniMode === null) return;
    clearTimeout(geometryTimer);
    const mode = appliedMiniMode;
    geometryTimer = setTimeout(() => {
      if (!changingMode && appliedMiniMode === mode) {
        void saveGeometry(mode).catch((e) => logError(`[main] geometry save failed: ${String(e)}`));
      }
    }, 200);
  }

  async function restorePosition(geometry: Geometry) {
    const win = getCurrentWebviewWindow();
    const monitors = await availableMonitors();
    const size = await win.outerSize();
    const monitor =
      monitors.find((m) => {
        const a = m.workArea;
        return (
          geometry.x < a.position.x + a.size.width &&
          geometry.x + size.width > a.position.x &&
          geometry.y < a.position.y + a.size.height &&
          geometry.y + size.height > a.position.y
        );
      }) ??
      (await currentMonitor()) ??
      monitors[0];
    if (!monitor) return;
    const area = monitor.workArea;
    const x = Math.max(
      area.position.x,
      Math.min(geometry.x, area.position.x + Math.max(0, area.size.width - size.width))
    );
    const y = Math.max(
      area.position.y,
      Math.min(geometry.y, area.position.y + Math.max(0, area.size.height - size.height))
    );
    await win.setPosition(new PhysicalPosition(x, y));
  }

  // Extra bottom padding added to <main> in compact mode.  Shifts the
  // dial upward so the whitespace sits at the bottom rather than being
  // split equally — compensates for the visual weight of the titlebar.
  const COMPACT_BOTTOM_PAD = 48;

  $effect(() => {
    function update() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      isCompact = w < COMPACT_THRESHOLD || h < COMPACT_THRESHOLD;
      if (isCompact) {
        // Scale so the dial fills the available space, reserving
        // COMPACT_BOTTOM_PAD px for the intentional bottom whitespace.
        const available = Math.min(w - 16, h - TITLEBAR_H - 16 - COMPACT_BOTTOM_PAD);
        uiScale = Math.max(0.4, Math.min(available / 220, 4));
      } else {
        // Scale proportionally to the base window dimensions.
        uiScale = Math.max(0.5, Math.min(w / BASE_W, (h - TITLEBAR_H) / (BASE_H - TITLEBAR_H), 4));
      }
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  });

  // Window shape is independent of its always-on-top flag.
  $effect(() => {
    if (!settingsLoaded) return;
    const mini = $settings.mini_mode;
    if (requestedMiniMode === mini) return;
    requestedMiniMode = mini;
    const win = getCurrentWebviewWindow();
    windowModeUpdates = windowModeUpdates
      .then(async () => {
        changingMode = true;
        geometryRevision++;
        clearTimeout(geometryTimer);
        if (appliedMiniMode !== null) await saveGeometry(appliedMiniMode, true);
        const saved = readGeometry(mini);
        const current = (await win.innerSize()).toLogical(await win.scaleFactor());
        if (
          appliedMiniMode === null &&
          mini &&
          !readGeometry(false) &&
          current.width > TOP_MODE_W &&
          current.height > TOP_MODE_H
        ) {
          await saveGeometry(false, true);
        }
        let normalSize = { width: BASE_W, height: BASE_H };
        try {
          const old = JSON.parse(localStorage.getItem(NORMAL_SIZE_KEY) ?? 'null');
          if (old?.width > TOP_MODE_W && old?.height > TOP_MODE_H) normalSize = old;
        } catch {
          /* Use the default normal size. */
        }
        if (appliedMiniMode === null && current.width > TOP_MODE_W && current.height > TOP_MODE_H) {
          normalSize = current;
        }
        const size = mini ? { width: TOP_MODE_W, height: TOP_MODE_H } : (saved ?? normalSize);
        // Keep a recovery entry while native operations are in progress or fail.
        await win.setSkipTaskbar(false);
        await win.setFullscreen(false);
        isFullscreen = false;
        if (await win.isMaximized()) await win.unmaximize();
        await win.setMaxSize(null);
        await win.setMinSize(new LogicalSize(TOP_MODE_W, TOP_MODE_H));
        await win.setSize(new LogicalSize(size.width, size.height));
        if (mini) {
          await win.setMaxSize(new LogicalSize(TOP_MODE_W, TOP_MODE_H));
        }
        await win.setResizable(!mini);
        await win.setMaximizable(!mini);
        await win.setSkipTaskbar(mini && (await miniTaskbarReady()));
        if (saved) await restorePosition(saved);
        else
          await restorePosition({
            x: (await win.outerPosition()).x,
            y: (await win.outerPosition()).y,
            ...size,
          });
        appliedMiniMode = mini;
        await saveGeometry(mini, true);
        const actual = (await win.innerSize()).toLogical(await win.scaleFactor());
        await info(
          `[main] window mode=${mini ? 'mini' : 'normal'} requested=${size.width}x${size.height} actual=${actual.width}x${actual.height}`
        );
        if (Math.abs(actual.width - size.width) > 1 || Math.abs(actual.height - size.height) > 1) {
          await logError(
            `[main] window size mismatch: requested=${size.width}x${size.height} actual=${actual.width}x${actual.height}`
          );
        }
      })
      .catch(async (e) => {
        await logError(`[main] failed to apply window mode: ${String(e)}`);
      })
      .finally(() => {
        changingMode = false;
      });
  });

  async function startResize(direction: string) {
    if ($settings.mini_mode) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getCurrentWebviewWindow().startResizeDragging(direction as any);
  }

  onMount(() => {
    const cleanups: UnlistenFn[] = [];
    const win = getCurrentWebviewWindow();

    // Mount local keyboard shortcut handler.
    const shortcutHandler = createLocalShortcutHandler({
      getSettings: () => $settings,
      getVolume: () => localVolume,
      setVolume: (v) => {
        localVolume = v;
      },
      getPreMuteVolume: () => preMuteVolume,
      setPreMuteVolume: (v) => {
        preMuteVolume = v;
      },
      getFullscreen: () => isFullscreen,
      setFullscreen: (v) => {
        isFullscreen = v;
      },
    });
    document.addEventListener('keydown', shortcutHandler);
    cleanups.push(() => document.removeEventListener('keydown', shortcutHandler));

    (async () => {
      // Magnetically attach the fixed-size overlay to the nearest monitor edge.
      cleanups.push(
        await listen('window:restore-main', () => {
          if ($settings.mini_mode)
            void setSetting('mini_mode', 'false').catch((e) => logError(String(e)));
        }),
        await win.onResized(() => scheduleGeometrySave()),
        await win.onMoved(async ({ payload: position }) => {
          scheduleGeometrySave();
          if (!$settings.mini_mode || changingMode || snapping) return;
          const revision = geometryRevision;
          const monitor = await currentMonitor();
          if (!monitor) return;

          const size = await win.outerSize();
          const threshold = 12 * monitor.scaleFactor;
          const right = position.x + size.width;
          const bottom = position.y + size.height;
          const area = monitor.workArea;
          const monitorRight = area.position.x + area.size.width;
          const monitorBottom = area.position.y + area.size.height;
          let x = position.x;
          let y = position.y;

          if (Math.abs(position.x - area.position.x) <= threshold) x = area.position.x;
          else if (Math.abs(right - monitorRight) <= threshold) x = monitorRight - size.width;
          if (Math.abs(position.y - area.position.y) <= threshold) y = area.position.y;
          else if (Math.abs(bottom - monitorBottom) <= threshold) y = monitorBottom - size.height;

          if (x !== position.x || y !== position.y) {
            if (changingMode || revision !== geometryRevision || !$settings.mini_mode) return;
            snapping = true;
            await win.setPosition(new PhysicalPosition(x, y));
            setTimeout(() => {
              snapping = false;
            }, 100);
          }
        })
      );

      try {
        // Load settings from backend.
        const s = await getSettings();
        settings.set(s);
        settingsLoaded = true;
        await tick();
        await windowModeUpdates;
        localVolume = s.volume;

        // Apply the stored locale on mount.
        setLocale(s.language);
        await info(`[main] settings loaded, locale=${s.language}`);

        // Load and apply the active theme using OS color scheme.
        const themes = await getThemes();
        const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const active = themes.find((t) => t.name === resolveThemeName(s, osDark)) ?? themes[0];
        if (active) applyTheme(active);
        await getCurrentWebviewWindow().show();
        await info(`[main] initialized, theme=${active?.name ?? 'none'}`);
      } catch (e) {
        await logError(`[main] initialization failed: ${e}`);
        throw e;
      }

      // Live OS color scheme changes — re-resolve only in auto mode.
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const mqListener = async (e: MediaQueryListEvent) => {
        if ($settings.theme_mode !== 'auto') return;
        const allThemes = await getThemes();
        const t = allThemes.find((th) => th.name === resolveThemeName($settings, e.matches));
        if (t) applyTheme(t);
      };
      mq.addEventListener('change', mqListener);
      cleanups.push(() => mq.removeEventListener('change', mqListener));

      // Keep settings store in sync with backend changes.
      cleanups.push(
        await onSettingsChanged(async (updated) => {
          const prevMode = $settings.theme_mode;
          const prevLight = $settings.theme_light;
          const prevDark = $settings.theme_dark;
          const prevLanguage = $settings.language;
          settings.set(updated);
          localVolume = updated.volume;
          if (updated.language !== prevLanguage) {
            setLocale(updated.language);
          }
          if (
            updated.theme_mode !== prevMode ||
            updated.theme_light !== prevLight ||
            updated.theme_dark !== prevDark
          ) {
            const allThemes = await getThemes();
            const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const t = allThemes.find((th) => th.name === resolveThemeName(updated, dark));
            if (t) applyTheme(t);
          }
        }),
        // Re-apply theme when custom themes are hot-reloaded.
        await onThemesChanged((updated) => {
          const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          const current =
            updated.find((t) => t.name === resolveThemeName($settings, dark)) ?? updated[0];
          if (current) applyTheme(current);
        })
      );
    })();

    return () => {
      clearTimeout(geometryTimer);
      for (const fn of cleanups) fn();
    };
  });
</script>

<!-- Resize handles — invisible edge/corner strips for decorations-free windows.
     Not needed on macOS where native resizing is provided by decorations:true. -->
{#if !isMac && !$settings.mini_mode}
  <!-- N -->
  <div class="rh rh-n" onmousedown={() => startResize('North')} role="none"></div>
  <!-- S -->
  <div class="rh rh-s" onmousedown={() => startResize('South')} role="none"></div>
  <!-- E -->
  <div class="rh rh-e" onmousedown={() => startResize('East')} role="none"></div>
  <!-- W -->
  <div class="rh rh-w" onmousedown={() => startResize('West')} role="none"></div>
  <!-- NE -->
  <div class="rh rh-ne" onmousedown={() => startResize('NorthEast')} role="none"></div>
  <!-- NW -->
  <div class="rh rh-nw" onmousedown={() => startResize('NorthWest')} role="none"></div>
  <!-- SE -->
  <div class="rh rh-se" onmousedown={() => startResize('SouthEast')} role="none"></div>
  <!-- SW -->
  <div class="rh rh-sw" onmousedown={() => startResize('SouthWest')} role="none"></div>
{/if}

<div class="app" class:top-mode={$settings.mini_mode}>
  {#if !$settings.mini_mode}
    <Titlebar />
  {/if}
  <main class:compact={isCompact}>
    <Timer {isCompact} {uiScale} overlay={$settings.mini_mode} />
  </main>
</div>

<style>
  .app {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: app-fade-in 0.4s var(--transition-slow) both;
  }

  main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  main.compact {
    /* Bottom padding provides breathing room below the mini controls. */
    padding-bottom: 8px;
  }

  .top-mode main {
    padding: 0;
  }

  .top-mode {
    background-color: transparent;
  }

  :global(html:has(.top-mode)),
  :global(body:has(.top-mode)) {
    background-color: transparent;
  }

  /* ---------------------------------------------------------------------------
     Resize handles — positioned outside/over the window edges so the user can
     grab them to resize a decoration-free window (needed on Linux/Wayland and
     GNOME with undecorated windows).
     --------------------------------------------------------------------------- */
  :global(.rh) {
    position: fixed;
    z-index: 9999;
  }

  /* Edge handles */
  :global(.rh-n) {
    top: 0;
    left: 6px;
    right: 6px;
    height: 5px;
    cursor: n-resize;
  }
  :global(.rh-s) {
    bottom: 0;
    left: 6px;
    right: 6px;
    height: 5px;
    cursor: s-resize;
  }
  :global(.rh-e) {
    right: 0;
    top: 6px;
    bottom: 6px;
    width: 5px;
    cursor: e-resize;
  }
  :global(.rh-w) {
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 5px;
    cursor: w-resize;
  }

  /* Corner handles (larger for easier grabbing) */
  :global(.rh-ne) {
    top: 0;
    right: 0;
    width: 10px;
    height: 10px;
    cursor: ne-resize;
  }
  :global(.rh-nw) {
    top: 0;
    left: 0;
    width: 10px;
    height: 10px;
    cursor: nw-resize;
  }
  :global(.rh-se) {
    bottom: 0;
    right: 0;
    width: 10px;
    height: 10px;
    cursor: se-resize;
  }
  :global(.rh-sw) {
    bottom: 0;
    left: 0;
    width: 10px;
    height: 10px;
    cursor: sw-resize;
  }
</style>
