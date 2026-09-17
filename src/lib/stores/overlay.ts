import { writable } from 'svelte/store';

const SNAP_KEY = 'pomotroid-overlay-snap-enabled';
export const overlaySnapEnabled = writable(true);

export function loadOverlaySnapping() {
  overlaySnapEnabled.set(localStorage.getItem(SNAP_KEY) !== 'false');
}

export function setOverlaySnapping(enabled: boolean) {
  overlaySnapEnabled.set(enabled);
  localStorage.setItem(SNAP_KEY, String(enabled));
}
