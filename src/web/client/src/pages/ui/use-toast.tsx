import React, { createContext, useContext, useState, ReactNode } from 'react';
import { clsx } from 'clsx';

interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  toast: (toast: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Standalone toast function reference for non-hook usage
let globalToastFn: ((toast: Omit<Toast, 'id'>) => string) | null = null;

export function toast(props: Omit<Toast, 'id'>) {
  if (globalToastFn) return globalToastFn(props);
  console.warn('toast() called outside ToastProvider');
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(7);
    setToasts(prev => [...prev, { ...t, id }]);
    if (t.duration !== 0) {
      setTimeout(() => dismiss(id), t.duration || 5000);
    }
    return id;
  };

  const dismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Register global toast function
  globalToastFn = addToast;

  return (
    <ToastContext.Provider value={{ toasts, toast: addToast, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const variants = {
    default: 'bg-background text-foreground',
    destructive: 'bg-destructive text-destructive-foreground',
  };

  return (
    <div
      className={clsx(
        'pointer-events-auto flex items-center gap-3 rounded-lg border p-4 shadow-lg min-w-[300px] max-w-md',
        variants[toast.variant || 'default']
      )}
    >
      <div className="flex-1">
        <p className="font-medium">{toast.title}</p>
        {toast.description && <p className="text-sm opacity-90">{toast.description}</p>}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-foreground/50 hover:text-foreground"
      >
        ✕
      </button>
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}