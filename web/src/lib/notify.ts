// Browser notification and a short sound for new customer messages.

import { getSettings } from "./settings";

let audioContext: AudioContext | null = null;

/** Two short tones, generated in the browser (no audio file to host). */
export function playSound(): void {
  try {
    audioContext ??= new AudioContext();
    const ctx = audioContext;
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime;
    [880, 1175].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const at = start + index * 0.14;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.14);
    });
  } catch {
    // Browsers block sound until the user has interacted with the page.
  }
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return "Notification" in window ? Notification.permission : "unsupported";
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

/**
 * Announces a new customer message according to the user's settings.
 * `quiet` is true when the staff member is already looking at that chat.
 */
export function announceMessage(input: { title: string; body: string; tag: string; quiet: boolean; onClick: () => void }): void {
  const settings = getSettings();
  if (input.quiet) return;
  if (settings.sound) playSound();
  if (settings.notifications && notificationPermission() === "granted") {
    try {
      const notification = new Notification(input.title, { body: input.body, tag: input.tag });
      notification.onclick = () => {
        window.focus();
        input.onClick();
        notification.close();
      };
    } catch {
      // Some mobile browsers only allow notifications from a service worker.
    }
  }
}
