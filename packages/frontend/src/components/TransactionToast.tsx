"use client";
import { useState, useEffect, useCallback } from "react";

type Status = "pending" | "confirming" | "confirmed" | "failed";
interface Toast {
  id: string;
  status: Status;
  txHash?: string;
  message?: string;
}

const COLORS: Record<Status, string> = {
  pending: "bg-yellow-50 border-yellow-400 text-yellow-900",
  confirming: "bg-blue-50 border-blue-400 text-blue-900",
  confirmed: "bg-green-50 border-green-400 text-green-900",
  failed: "bg-red-50 border-red-400 text-red-900",
};

/**
 * A text glyph per status, so the state is not carried by the border colour
 * alone. Marked aria-hidden because the adjacent label already says it.
 */
const ICONS: Record<Status, string> = {
  pending: "\u25CB",
  confirming: "\u25D4",
  confirmed: "\u2713",
  failed: "\u2715",
};

/** Sentence read out when a toast appears or changes state. */
const ANNOUNCEMENTS: Record<Status, string> = {
  pending: "Transaction pending",
  confirming: "Transaction confirming",
  confirmed: "Transaction confirmed",
  failed: "Transaction failed",
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (toast.status !== "confirmed") return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [toast.status, onDismiss]);

  // The live role sits on the item, not the wrapping container. Nesting one
  // inside the other makes assistive tech announce the same change twice.
  //
  // A failure is assertive because it interrupts a high-value action the user
  // is waiting on; progress and success are polite so they do not cut across
  // whatever is being read.
  const isFailure = toast.status === "failed";

  return (
    <div
      role={isFailure ? "alert" : "status"}
      aria-live={isFailure ? "assertive" : "polite"}
      aria-atomic="true"
      className={`border rounded-lg p-3 mb-2 text-sm shadow-md ${COLORS[toast.status]}`}
    >
      {/* One concise sentence carries the state change; the visual row below is
          hidden from the announcement so the same information is not read
          twice. */}
      <span className="sr-only">
        {ANNOUNCEMENTS[toast.status]}
        {toast.message ? `. ${toast.message}` : ""}
      </span>
      <div
        className="flex justify-between items-center gap-2"
        aria-hidden="true"
      >
        <span className="font-semibold capitalize">
          <span className="mr-1">{ICONS[toast.status]}</span>
          {toast.status}
        </span>
      </div>

      {/* Interactive controls stay outside the aria-hidden block; hiding them
          would make them unreachable to screen reader users. */}
      <div className="flex justify-end items-center gap-3 mt-1">
        {toast.txHash && (
          <a
            href={`https://stellar.expert/explorer/public/tx/${toast.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="underline text-xs"
          >
            View transaction, opens in a new tab
          </a>
        )}
        {isFailure && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs underline"
          >
            Dismiss transaction failure
          </button>
        )}
      </div>

      {toast.message && (
        <p className="mt-1 text-xs opacity-80" aria-hidden="true">
          {toast.message}
        </p>
      )}
    </div>
  );
}

export function useTransactionToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const add = useCallback((data: Omit<Toast, "id">): string => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((p) => [...p.slice(-2), { ...data, id }]);
    return id;
  }, []);
  const update = useCallback(
    (id: string, patch: Partial<Toast>) =>
      setToasts((p) => p.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    [],
  );
  const remove = useCallback(
    (id: string) => setToasts((p) => p.filter((t) => t.id !== id)),
    [],
  );
  return { toasts, add, update, remove };
}

export function TransactionToasts({
  toasts,
  remove,
}: {
  toasts: Toast[];
  remove: (id: string) => void;
}) {
  return (
    // A plain labelled region, deliberately not a live region itself: each
    // toast announces its own change, and wrapping them would double it.
    <div
      className="fixed bottom-4 right-4 w-72 z-50 pointer-events-none"
      role="region"
      aria-label="Transaction notifications"
    >
      <div className="pointer-events-auto">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
    </div>
  );
}
