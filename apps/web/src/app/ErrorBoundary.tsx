import { Component, type ReactNode } from "react";
import { reportError } from "../shared/clientErrors.ts";

/**
 * ErrorBoundary catches a crash while the app draws, reports it to the server's log, and shows a reload note instead of a blank
 * page. With no error it renders its children and adds nothing to the page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    reportError(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p role="alert">
        Something went wrong.{" "}
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </p>
    );
  }
}
