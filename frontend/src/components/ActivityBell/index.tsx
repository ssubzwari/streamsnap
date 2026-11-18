import { useCallback, useEffect, useRef, useState } from "react";

import { listNotifications, markAllRead } from "@/api/notifications";
import type { NotificationInfo } from "@/ws/events";
import { WS_EVENTS } from "@/ws/events";
import { getSocket } from "@/ws/socket";

import styles from "./ActivityBell.module.css";

/** Kinds that deserve the badge painted as a problem rather than news. */
const PROBLEM_KINDS = new Set(["failed", "subscription_error", "auth_required"]);

function timeAgo(iso: string): string {
  const then = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.3 21a2 2 0 0 0 3.4 0" strokeLinecap="round" />
    </svg>
  );
}

interface Props {
  className?: string;
}

/** The home for things that happen when you are not looking.
 *
 *  Replaces the corner toasts and the browser notifications: a download that
 *  finishes ten minutes after you queued it has no button to report back to,
 *  so it lands here instead of covering the page. Nothing is thrown in front
 *  of the user — the badge changes and they look when they want to.
 */
export default function ActivityBell({ className = "" }: Props) {
  const [items, setItems] = useState<NotificationInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const pulseTimer = useRef<number | undefined>(undefined);

  const unread = items.filter((n) => !n.is_read).length;
  const hasProblem = items.some((n) => !n.is_read && PROBLEM_KINDS.has(n.kind));

  const refresh = useCallback(() => {
    listNotifications()
      .then((rows) => setItems(rows.slice(0, 50)))
      .catch(() => {});
  }, []);

  // Seed from the server so a reload doesn't lose what happened while away,
  // then keep checking. The socket is the fast path, not the only one: behind
  // a proxy that refuses the websocket upgrade it never connects, and a bell
  // that only listens would sit empty while downloads finished. Polling is
  // cheap (one small request a minute) and makes it independent of that.
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 45_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Live arrivals: prepend and give the bell one short nudge.
  useEffect(() => {
    const socket = getSocket();
    const handler = (data: NotificationInfo) => {
      setItems((prev) => [data, ...prev].slice(0, 50));
      setPulse(true);
      window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setPulse(false), 900);
    };
    socket.on(WS_EVENTS.NOTIFICATION_CREATED, handler);
    return () => {
      socket.off(WS_EVENTS.NOTIFICATION_CREATED, handler);
      window.clearTimeout(pulseTimer.current);
    };
  }, []);

  // Click-away and Escape close the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) refresh();
    if (next && unread > 0) {
      // Opening it is reading it.
      setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
      markAllRead().catch(() => {});
    }
  };

  return (
    <div className={styles.wrap} ref={wrap}>
      <button
        type="button"
        className={`${className} ${styles.bell} ${pulse ? styles.pulse : ""}`.trim()}
        onClick={toggle}
        aria-label={unread ? `Activity, ${unread} unread` : "Activity"}
        aria-expanded={open}
        title="Activity"
      >
        <BellIcon />
        {unread > 0 && (
          <span className={`${styles.badge} ${hasProblem ? styles.badgeProblem : ""}`.trim()}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Recent activity">
          <div className={styles.panelHead}>
            <span>Activity</span>
          </div>
          {items.length === 0 ? (
            <p className={styles.empty}>Nothing yet.</p>
          ) : (
            <ul className={styles.list}>
              {items.slice(0, 20).map((n) => (
                <li
                  key={n.id}
                  className={`${styles.item} ${PROBLEM_KINDS.has(n.kind) ? styles.itemProblem : ""}`.trim()}
                >
                  <span className={styles.itemTitle}>{n.title}</span>
                  {n.body && <span className={styles.itemBody}>{n.body}</span>}
                  <span className={styles.itemTime}>{timeAgo(n.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
