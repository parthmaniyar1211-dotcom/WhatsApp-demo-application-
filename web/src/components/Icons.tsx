// Small inline SVG icons (no icon library).

import type { MessageStatus } from "../lib/types";

type IconName =
  | "reply" | "star" | "starFilled" | "more" | "emoji" | "mic" | "attach" | "search" | "close" | "info"
  | "settings" | "chat" | "newchat" | "lock" | "logout" | "sun" | "bell" | "edit" | "down" | "send" | "trash" | "copy" | "hide" | "pin" | "contact" | "forward" | "back" | "stop";

const PATHS: Record<IconName, string> = {
  reply: "M10 8V4l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
  star: "M12 17.3l-5.5 3.3 1.5-6.2L3.2 10l6.4-.5L12 3.6l2.4 5.9 6.4.5-4.8 4.4 1.5 6.2z",
  starFilled: "M12 17.3l-5.5 3.3 1.5-6.2L3.2 10l6.4-.5L12 3.6l2.4 5.9 6.4.5-4.8 4.4 1.5 6.2z",
  more: "M12 8a2 2 0 100-4 2 2 0 000 4zm0 2a2 2 0 100 4 2 2 0 000-4zm0 6a2 2 0 100 4 2 2 0 000-4z",
  emoji: "M12 2a10 10 0 100 20 10 10 0 000-20zm-3.5 6a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm7 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 18c-2.3 0-4.3-1.4-5.1-3.5h10.2C16.3 16.6 14.3 18 12 18z",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V22h2v-3.1A7 7 0 0019 12h-2z",
  attach: "M16.5 6.5v10a4.5 4.5 0 01-9 0V5.5a3 3 0 016 0v10.25a1.5 1.5 0 01-3 0V6.5H9v9.25a3 3 0 006 0V5.5a4.5 4.5 0 00-9 0v11a6 6 0 0012 0v-10h-1.5z",
  search: "M15.5 14h-.8l-.3-.3A6.5 6.5 0 109.5 16a6.5 6.5 0 004.2-1.6l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 110-9 4.5 4.5 0 010 9z",
  close: "M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
  info: "M11 17h2v-6h-2v6zm1-15a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zM11 9h2V7h-2v2z",
  settings: "M19.4 13a7.5 7.5 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 000 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.3-1.6zM13 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z",
  down: "M7.4 8.6L12 13.2l4.6-4.6L18 10l-6 6-6-6z",
  chat: "M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2zm-3 10H7v-2h10v2zm0-3H7V7h10v2z",
  newchat: "M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-3 10h-3v3h-2v-3H8v-2h3V8h2v3h3v2z",
  lock: "M18 8h-1V6a5 5 0 00-10 0v2H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V10a2 2 0 00-2-2zm-6 9a2 2 0 110-4 2 2 0 010 4zm3.1-9H8.900V6a3.1 3.1 0 016.2 0v2z",
  logout: "M17 7l-1.4 1.4 2.6 2.600H8v2h10.200l-2.6 2.600L17 17l5-5-5-5zM4 5h8V3H4a2 2 0 00-2 2v14a2 2 0 002 2h8v-2H4V5z",
  sun: "M12 7a5 5 0 100 10 5 5 0 000-10zM2 13h2v-2H2v2zm18 0h2v-2h-2v2zM11 2v2h2V2h-2zm0 18v2h2v-2h-2zM5.990 4.580L4.580 5.990l1.410 1.410 1.410-1.410-1.410-1.410zm12.020 12.020l-1.410 1.410 1.410 1.410 1.410-1.410-1.410-1.410zM18.010 7.400l1.410-1.410-1.410-1.410-1.410 1.410 1.410 1.410zM5.990 18.010l1.410 1.410-1.410 1.410-1.410-1.410z",
  bell: "M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6v-5c0-3.1-1.6-5.6-4.5-6.300V4a1.5 1.5 0 00-3 0v.700C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1l-2-2z",
  edit: "M3 17.250V21h3.750L17.810 9.940l-3.750-3.750L3 17.250zM20.710 7.040a1 1 0 000-1.410l-2.340-2.340a1 1 0 00-1.410 0l-1.830 1.830 3.750 3.750 1.830-1.830z",
  send: "M2 21l21-9L2 3v7l15 2-15 2z",
  trash: "M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  copy: "M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z",
  hide: "M12 7a5 5 0 015 5c0 .6-.1 1.3-.4 1.8l2.9 3A11.8 11.8 0 0023 12c-1.7-4.4-6-7.5-11-7.5-1.4 0-2.7.2-4 .700l2.2 2.200c.6-.3 1.2-.4 1.8-.400zM2 4.300l2.3 2.3.5.500A11.8 11.8 0 001 12c1.7 4.4 6 7.5 11 7.5 1.5 0 3-.3 4.4-.800l.4.4 2.9 2.9 1.3-1.300L3.3 3 2 4.300zM7.5 9.800l1.6 1.6-.1.600a3 3 0 003 3l.6-.1 1.6 1.600c-.7.3-1.4.5-2.2.500a5 5 0 01-5-5c0-.8.2-1.5.5-2.200z",
  pin: "M12 2a7 7 0 00-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 00-7-7zm0 9.500a2.5 2.5 0 110-5 2.5 2.5 0 010 5z",
  contact: "M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z",
  forward: "M14 8V4l7 7-7 7v-4.100c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z",
  back: "M15.4 7.400L14 6l-6 6 6 6 1.4-1.400L10.8 12z",
  stop: "M6 6h12v12H6z",
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={`icon icon-${name}`}>
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}

const STATUS_LABEL: Record<MessageStatus, string> = {
  received: "Received",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  played: "Played",
  failed: "Failed",
};

/**
 * WhatsApp-style ticks: clock (sending), one grey tick (sent), two grey ticks (delivered),
 * two blue ticks (read / played), red mark (failed). The label is available to screen readers and tests.
 */
export function Ticks({ status }: { status: MessageStatus }) {
  const label = STATUS_LABEL[status];
  let drawing;
  if (status === "sending") {
    drawing = (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.5V8l2.3 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  } else if (status === "failed") {
    drawing = (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 4v5M8 11.300v.2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  } else if (status === "sent") {
    drawing = (
      <svg viewBox="0 0 16 12" width="15" height="11" aria-hidden="true">
        <path d="M2 6.500l3.5 3.500L13 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  } else {
    drawing = (
      <svg viewBox="0 0 20 12" width="19" height="11" aria-hidden="true">
        <path d="M1 6.500l3.5 3.500L12 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 9.500l.5.500L16 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <span className={`ticks ${status}`} role="img" aria-label={label} title={label} data-testid="message-status" data-status={status}>
      {drawing}
    </span>
  );
}
