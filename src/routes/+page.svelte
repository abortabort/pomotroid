<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import Titlebar from '$lib/components/Titlebar.svelte';
  import Timer from '$lib/components/Timer.svelte';
  import { getSettings, getThemes, onSettingsChanged, onThemesChanged } from '$lib/ipc';
  import { settings } from '$lib/stores/settings';
  import { applyTheme } from '$lib/stores/theme';
  import { resolveThemeName } from '$lib/utils/theme';
  import { isMac } from '$lib/utils/platform';
  import { setLocale } from '$lib/locale.svelte.js';
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { info, error as logError } from '@tauri-apps/plugin-log';
  import { createLocalShortcutHandler } from '$lib/utils/localShortcuts';
  import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
  import { currentMonitor } from '@tauri-apps/api/window';

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
  let normalWindowSize = $state<{ width: number; height: number } | null>(null);
  let appliedTopMode = $state(false);
  let settingsLoaded = $state(false);
  let snapping = false;
  let windowModeUpdates: Promise<void> = Promise.resolve();

  // A small, text-only overlay is easier to keep visible while working.
  const TOP_MODE_W = 160;
  const TOP_MODE_H = 30;
  const NORMAL_SIZE_KEY = 'pomotroid-normal-window-size';

  // Extra bottom padding added to <main> in compact mode.  Shifts the
  // dial upward so the whitespace sits at the bottom rather than being
  // split equally — compensates for the visual weight of the titlebar.
  const COMPACT_BOTTOM_PAD = 48;

  $effect(() => {
    function update() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (settingsLoaded && !$settings.always_on_top && !appliedTopMode && w > TOP_MODE_W && h > TOP_MODE_H) {
        localStorage.setItem(NORMAL_SIZE_KEY, JSON.stringify({ width: w, height: h }));
      }
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

  // Keep the always-on-top view compact without losing the user's normal size.
  $effect(() => {
    if (!settingsLoaded) return;
    const topMode = $settings.always_on_top;
    const win = getCurrentWebviewWindow();
    let requestedSize: { width: number; height: number };

    if (topMode && !appliedTopMode) {
      try {
        const saved = JSON.parse(localStorage.getItem(NORMAL_SIZE_KEY) ?? 'null');
        if (saved?.width > TOP_MODE_W && saved?.height > TOP_MODE_H) {
          normalWindowSize = { width: saved.width, height: saved.height };
        }
      } catch {
        // Fall back to the current size when no valid normal size is saved.
      }
      normalWindowSize ??= { width: 360, height: 478 };
      appliedTopMode = true;
      requestedSize = { width: TOP_MODE_W, height: TOP_MODE_H };
    } else if (!topMode && appliedTopMode) {
      appliedTopMode = false;
      requestedSize = normalWindowSize ?? { width: BASE_W, height: BASE_H };
      normalWindowSize = null;
    } else {
      return;
    }

    // Serialize native operations so rapid mode switches cannot restore an old size.
    windowModeUpdates = windowModeUpdates.then(async () => {
      if (topMode) {
        await win.setFullscreen(false);
        if (await win.isMaximized()) await win.unmaximize();
      }
      await win.setSize(new LogicalSize(requestedSize.width, requestedSize.height));
      await win.setResizable(!topMode);
      await win.setSkipTaskbar(topMode);
      const actual = (await win.innerSize()).toLogical(await win.scaleFactor());
      await info(`[main] window mode=${topMode ? 'overlay' : 'normal'} requested=${requestedSize.width}x${requestedSize.height} actual=${actual.width}x${actual.height}`);
      if (Math.abs(actual.width - requestedSize.width) > 1 || Math.abs(actual.height - requestedSize.height) > 1) {
        await logError(`[main] window size mismatch: requested=${requestedSize.width}x${requestedSize.height} actual=${actual.width}x${actual.height}`);
      }
    }).catch(async (e) => {
      await logError(`[main] failed to apply window mode: ${String(e)}`);
    });
  });

  async function startResize(direction: string) {
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
        await win.onMoved(async ({ payload: position }) => {
          if (!$settings.always_on_top || snapping) return;
          const monitor = await currentMonitor();
          if (!monitor) return;

          const size = await win.outerSize();
          const threshold = 16;
          const right = position.x + size.width;
          const bottom = position.y + size.height;
          const monitorRight = monitor.position.x + monitor.size.width;
          const monitorBottom = monitor.position.y + monitor.size.height;
          let x = position.x;
          let y = position.y;

          if (Math.abs(position.x - monitor.position.x) <= threshold) x = monitor.position.x;
          else if (Math.abs(right - monitorRight) <= threshold) x = monitorRight - size.width;
          if (Math.abs(position.y - monitor.position.y) <= threshold) y = monitor.position.y;
          else if (Math.abs(bottom - monitorBottom) <= threshold) y = monitorBottom - size.height;

          if (x !== position.x || y !== position.y) {
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
      for (const fn of cleanups) fn();
    };
  });
</script>

<!-- Resize handles — invisible edge/corner strips for decorations-free windows.
     Not needed on macOS where native resizing is provided by decorations:true. -->
{#if !isMac}
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

<div class="app" class:top-mode={$settings.always_on_top}>
  {#if !$settings.always_on_top}
    <Titlebar />
  {/if}
  <main class:compact={isCompact}>
    <Timer {isCompact} {uiScale} overlay={$settings.always_on_top} />
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
