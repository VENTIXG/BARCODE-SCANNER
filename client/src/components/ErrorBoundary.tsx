import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Catches render errors so a bug shows a message with a way out, instead of a blank page.
 * Wraps the whole app and the page area (the layout stays usable when one page fails).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render error', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Leaving the broken page (route change) clears the error.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-16 max-w-md rounded-xl border border-bad/30 bg-bad-soft p-6 text-center">
        <p className="text-base font-semibold text-bad">Η σελίδα δεν μπόρεσε να εμφανιστεί.</p>
        <p className="mt-2 text-sm text-fg-2">
          Δεν χάθηκαν δεδομένα. Δοκιμάστε ξανά ή επιστρέψτε στην αρχική σελίδα.
        </p>
        <p className="mt-3 break-words font-mono text-xs text-muted">{this.state.error.message}</p>
        <div className="mt-5 flex justify-center gap-2">
          <button className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-fg" onClick={() => this.setState({ error: null })}>
            Δοκιμή ξανά
          </button>
          <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white" onClick={() => (window.location.href = '/')}>
            Αρχική σελίδα
          </button>
        </div>
      </div>
    );
  }
}
