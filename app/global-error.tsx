"use client";

// Explicit App Router global-error boundary.
//
// Why this file exists: without it, Next synthesizes a default `/_global-error`
// page and tries to prerender it during `next build`. On the Turbopack build path
// (Next 16) that synthetic export can trip
//   InvariantError: Expected workStore to be initialized
// and abort the whole build. Providing a real "use client" boundary here means Next
// exports OUR component for `/_global-error` instead of the broken synthetic one, so
// the build completes cleanly. (It's also the actual UX when the root layout throws.)
//
// A global-error boundary REPLACES the root layout, so it must render its own
// <html>/<body>. Keep styles inline — globals.css may not be applied in this state.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          color: "#fb923c",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
        }}
      >
        <div style={{ maxWidth: 560, padding: "2rem", textAlign: "center" }}>
          <div style={{ fontSize: 12, letterSpacing: "0.2em", color: "#9ca3af" }}>
            BLOOMBERG TERMINAL
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0.75rem 0" }}>
            Something went wrong.
          </h1>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 0.5rem" }}>
            An unexpected error broke the application shell.
          </p>
          {error?.digest && (
            <p style={{ fontSize: 11, color: "#6b7280", margin: "0 0 1.25rem" }}>
              ref: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              cursor: "pointer",
              padding: "0.5rem 1rem",
              fontSize: 12,
              fontWeight: 700,
              color: "#000",
              background: "#ea580c",
              border: "none",
              borderRadius: 4,
            }}
          >
            RELOAD
          </button>
        </div>
      </body>
    </html>
  );
}
