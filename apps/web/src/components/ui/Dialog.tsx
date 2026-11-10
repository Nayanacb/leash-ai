import { useEffect, useRef, type ReactNode } from 'react';

/** Modal built on the native <dialog> element (focus trapping and Esc handling for free). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** When false, Esc and backdrop clicks do not close the dialog (used for the one-time key reveal). */
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-label={title}
      open={
        typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal
          ? true
          : undefined
      }
      onCancel={(e) => {
        e.preventDefault();
        if (dismissable) onClose();
      }}
      onClick={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </dialog>
  );
}
