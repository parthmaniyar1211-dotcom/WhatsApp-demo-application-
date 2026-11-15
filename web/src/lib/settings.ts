// Per-browser preferences (theme, notifications, sound), kept in localStorage.

import { useSyncExternalStore } from "react";

export interface Settings {
  theme: "system" | "light" | "dark";
  notifications: boolean;
  sound: boolean;
}

const KEY = "inbox-settings";
const DEFAULTS: Settings = { theme: "dark", notifications: false, sound: true };
const listeners = new Set<() => void>();
let current: Settings = read();

function read(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return {
      theme: stored.theme === "light" || stored.theme === "system" ? stored.theme : "dark",
      notifications: stored.notifications === true,
      sound: stored.sound !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode: the setting lasts until the tab is closed.
  }
  applyTheme();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings);
}

/** Sets data-theme on <html>. "system" follows the device setting. */
export function applyTheme(): void {
  const dark =
    current.theme === "dark" ||
    (current.theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

applyTheme();
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
