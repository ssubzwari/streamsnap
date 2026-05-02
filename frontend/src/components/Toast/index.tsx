import { useEffect, useRef, useState } from "react";
import styles from "./Toast.module.css";
import { getSocket } from "@/ws/socket";
import { WS_EVENTS } from "@/ws/events";

interface ToastItem {
  id: number;
  kind: "info" | "success" | "warn" | "error";
  title: string;
  body?: string;
  thumbnail?: string;
}

let _nextId = 1;

// Map backend notification kinds to a toast variant for the border-left color.
const KIND_VARIANT: Record<string, ToastItem["kind"]> = {
  download_started:   "info",
  completed:          "success",
  failed:             "error",
  playlist_completed: "success",
  new_video:          "info",
  subscription_error: "error",
};

function requestBrowserPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function fireBrowserNotification(title: string, body?: string, image?: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  // `icon` shows on every platform; `image` is a hero image (Chrome/Android).
  new Notification(title, { body, icon: image || "/favicon.ico", image } as NotificationOptions & { image?: string });
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const permissionRequested = useRef(false);

  useEffect(() => {
    if (!permissionRequested.current) {
      permissionRequested.current = true;
      requestBrowserPermission();
    }
  }, []);

  useEffect(() => {
    const socket = getSocket();

    const handler = (data: { kind?: string; title?: string; body?: string; thumbnail?: string }) => {
      const variant = KIND_VARIANT[data.kind ?? ""] ?? "info";
      const item: ToastItem = {
        id: _nextId++,
        kind: variant,
        title: data.title ?? "Notification",
        body: data.body,
        thumbnail: data.thumbnail,
      };
      setToasts((prev) => [...prev.slice(-4), item]);
      fireBrowserNotification(item.title, item.body, item.thumbnail);

      // Auto-dismiss after 4s
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== item.id));
      }, 4000);
    };

    socket.on(WS_EVENTS.NOTIFICATION_CREATED, handler);
    return () => { socket.off(WS_EVENTS.NOTIFICATION_CREATED, handler); };
  }, []);

  const dismiss = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container}>
      {toasts.map((t) => (
        <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`}>
          {t.thumbnail && (
            <img
              className={styles.toastThumb}
              src={t.thumbnail}
              alt=""
              loading="lazy"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <div className={styles.toastContent}>
            <span className={styles.toastTitle}>{t.title}</span>
            {t.body && <span className={styles.toastBody}>{t.body}</span>}
          </div>
          <button className={styles.toastClose} onClick={() => dismiss(t.id)}>
            &#x2715;
          </button>
        </div>
      ))}
    </div>
  );
}
