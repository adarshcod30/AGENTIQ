/**
 * Toasts: bottom-right, 4s, single action. Errors persist until dismissed
 * (docs/04_App_UI.md §6).
 */
import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (tone: ToastTone, message: string) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (tone, message) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, tone, message }] }));
    // Errors stay until dismissed; everything else clears itself.
    if (tone !== 'danger') {
      setTimeout(() => get().dismiss(id), 4000);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
