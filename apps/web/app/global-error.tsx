"use client"

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body className="bg-slate-100 text-slate-900">
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold">Application error</h2>
            <p className="mt-2 text-sm text-slate-600">
              The app hit an unexpected error while loading the workspace shell. Refreshing usually restores the session.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              className="mt-4 inline-flex items-center justify-center rounded-xl border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            >
              Retry application
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
