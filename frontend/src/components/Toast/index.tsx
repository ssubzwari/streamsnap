import { useEffect, useState } from "react";
import styles from "./Toast.module.css";
import { getSocket } from "@/ws/socket";
import { WS_EVENTS } from "@/ws/events";

interface ToastItem {
  id: number;
  kind: "info" | "success" | "warn" | "error";
  title: string;
  body?: string;
}

let _nextId = 1;

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const socket = getSocket();

    const handler = (data: { kind?: string; title?: string; body?: string }) => {
      const kind = (data.kind ?? "info") as ToastItem["kind"];
      const item: ToastItem = {
        id: _nextId++,
        kind,
        title: data.title ?? "Notification",
        body: data.body,
      };
      setToasts((prev) => [...prev.slice(-4), item]);

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
