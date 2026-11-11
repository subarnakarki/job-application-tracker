import { useEffect, useId, useRef } from 'react';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A native <dialog>: focus is trapped and Escape closes it, with no extra library. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // Unique per dialog: a page may hold several (the application page has three).
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onCancel} className="dlg">
      <h2 id={titleId} className="text-[1.375rem] font-semibold tracking-[-0.035em]">
        {title}
      </h2>
      <p className="mt-2 text-[0.9375rem] text-fg-2">{message}</p>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onCancel} className="btn-d">
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} className="btn-red">
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
