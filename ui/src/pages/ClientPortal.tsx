import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";

// ---------------------------------------------------------------------------
// Types — must match server/src/routes/ledgerix-dashboard.ts /portal response
// ---------------------------------------------------------------------------

interface PortalThisMonth {
  transactionsProcessed: number | null;
  autoCategorized: number | null;
  reconciled: number | null;
  flagged: number | null;
  bookStatus: "current" | "attention_needed" | "unknown";
}

interface PortalWeek {
  weekOf: string;
  transactionsProcessed: number | null;
  autoCategorized: number | null;
  reconciled: number | null;
  flagged: number | null;
}

interface PortalData {
  contactName: string;
  companyName: string | null;
  serviceTier: string;
  platform: "quickbooks" | "xero" | null;
  thisMonth: PortalThisMonth;
  weeklyHistory: PortalWeek[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const numberFmt = new Intl.NumberFormat("en-US");
function fmtNum(n: number | null): string {
  return n == null ? "—" : numberFmt.format(n);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | null;
  tone?: "default" | "warning" | "good";
}) {
  const valueColor =
    tone === "warning" ? "text-[#F5A623]" : tone === "good" ? "text-emerald-600" : "text-[#0F1E38]";
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm">
      <div className={`text-3xl font-bold font-mono tabular-nums ${valueColor}`}>{fmtNum(value)}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function StatusBlock({ status, flagged }: { status: PortalThisMonth["bookStatus"]; flagged: number | null }) {
  if (status === "attention_needed") {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 flex items-start gap-4">
        <div className="text-3xl leading-none text-[#F5A623]">⚠</div>
        <div>
          <div className="text-lg font-semibold text-[#0F1E38]">
            {flagged ?? 0} item{(flagged ?? 0) === 1 ? "" : "s"} need attention
          </div>
          <div className="text-sm text-gray-600 mt-1">
            We'll be in touch shortly with details. No action needed from you right now.
          </div>
        </div>
      </div>
    );
  }
  if (status === "unknown") {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 flex items-start gap-4">
        <div className="text-3xl leading-none text-gray-400">•</div>
        <div>
          <div className="text-lg font-semibold text-gray-700">Activity will appear here soon</div>
          <div className="text-sm text-gray-500 mt-1">
            Your bookkeeping run hasn't started yet. Check back after your first cycle completes.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 flex items-start gap-4">
      <div className="text-3xl leading-none text-emerald-600">✓</div>
      <div>
        <div className="text-lg font-semibold text-[#0F1E38]">Your books are current and up to date</div>
        <div className="text-sm text-gray-600 mt-1">
          Everything has been categorized and reconciled. Nothing needs your attention.
        </div>
      </div>
    </div>
  );
}

function WeeklyTable({ rows }: { rows: PortalWeek[] }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Desktop table */}
      <table className="w-full text-sm hidden sm:table">
        <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
          <tr>
            <th className="text-left px-5 py-3 font-medium">Week of</th>
            <th className="text-right px-5 py-3 font-medium">Transactions</th>
            <th className="text-right px-5 py-3 font-medium">Categorized</th>
            <th className="text-right px-5 py-3 font-medium">Reconciled</th>
            <th className="text-center px-5 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const flaggedThisWeek = (w.flagged ?? 0) > 0;
            return (
              <tr key={w.weekOf} className="border-t border-gray-100">
                <td className="px-5 py-3 text-gray-700">{w.weekOf}</td>
                <td className="px-5 py-3 text-right font-mono tabular-nums">{fmtNum(w.transactionsProcessed)}</td>
                <td className="px-5 py-3 text-right font-mono tabular-nums">{fmtNum(w.autoCategorized)}</td>
                <td className="px-5 py-3 text-right font-mono tabular-nums">{fmtNum(w.reconciled)}</td>
                <td className="px-5 py-3 text-center">
                  {flaggedThisWeek ? (
                    <span className="text-[#F5A623]" title={`${w.flagged} flagged`}>⚠</span>
                  ) : (
                    <span className="text-emerald-600">✓</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Mobile stacked cards */}
      <div className="sm:hidden divide-y divide-gray-100">
        {rows.map((w) => {
          const flaggedThisWeek = (w.flagged ?? 0) > 0;
          return (
            <div key={w.weekOf} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-gray-700">{w.weekOf}</div>
                {flaggedThisWeek ? (
                  <span className="text-[#F5A623]">⚠</span>
                ) : (
                  <span className="text-emerald-600">✓</span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-gray-500">Transactions</div>
                  <div className="font-mono tabular-nums text-sm">{fmtNum(w.transactionsProcessed)}</div>
                </div>
                <div>
                  <div className="text-gray-500">Categorized</div>
                  <div className="font-mono tabular-nums text-sm">{fmtNum(w.autoCategorized)}</div>
                </div>
                <div>
                  <div className="text-gray-500">Reconciled</div>
                  <div className="font-mono tabular-nums text-sm">{fmtNum(w.reconciled)}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ErrorCard({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="max-w-md mx-auto mt-20 bg-white border border-gray-200 rounded-lg p-8 shadow-sm text-center">
      <h2 className="text-xl font-semibold text-[#0F1E38] mb-2">{title}</h2>
      <p className="text-sm text-gray-600">{body}</p>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="max-w-md mx-auto mt-20 flex items-center justify-center gap-3 text-gray-500">
      <span className="inline-block w-3 h-3 rounded-full bg-[#F5A623] animate-pulse" />
      Loading your books…
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ClientPortal() {
  const { contactId } = useParams<{ contactId: string }>();
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<{ kind: "not_found" | "generic"; message?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!contactId) {
      setError({ kind: "not_found" });
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/${encodeURIComponent(contactId)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setError({ kind: "not_found" });
          return;
        }
        if (!res.ok) {
          setError({ kind: "generic", message: `HTTP ${res.status}` });
          return;
        }
        const json = (await res.json()) as PortalData;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError({ kind: "generic", message: e instanceof Error ? e.message : String(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  // ---- Render ----
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 font-sans text-[#0F1E38]">
        <Header />
        <LoadingSpinner />
      </div>
    );
  }

  if (error?.kind === "not_found") {
    return (
      <div className="min-h-screen bg-gray-50 font-sans text-[#0F1E38]">
        <Header />
        <ErrorCard
          title="Portal not found"
          body={
            <>
              We couldn't find a client portal at this address. If you think this is wrong, contact us at{" "}
              <a href="mailto:scott@ledgerixpro.com" className="text-[#F5A623] hover:underline">
                scott@ledgerixpro.com
              </a>
              .
            </>
          }
        />
        <Footer />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-50 font-sans text-[#0F1E38]">
        <Header />
        <ErrorCard
          title="We couldn't load your books"
          body={
            <>
              Something went wrong on our end. Please try again in a moment, or contact{" "}
              <a href="mailto:scott@ledgerixpro.com" className="text-[#F5A623] hover:underline">
                scott@ledgerixpro.com
              </a>
              .
            </>
          }
        />
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-[#0F1E38]">
      <Header data={data} />

      <main className="max-w-5xl mx-auto px-5 sm:px-8 py-8 space-y-10">
        {/* Section 1 — This month */}
        <section>
          <div className="flex items-end justify-between mb-3">
            <h2 className="text-xs uppercase tracking-widest text-gray-500 font-medium">This Month's Activity</h2>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Transactions Processed" value={data.thisMonth.transactionsProcessed} />
            <MetricCard label="Auto-Categorized" value={data.thisMonth.autoCategorized} />
            <MetricCard label="Reconciled" value={data.thisMonth.reconciled} />
            <MetricCard
              label="Items Flagged"
              value={data.thisMonth.flagged}
              tone={(data.thisMonth.flagged ?? 0) > 0 ? "warning" : "good"}
            />
          </div>
        </section>

        {/* Section 2 — Book status */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-gray-500 font-medium mb-3">Book Status</h2>
          <StatusBlock status={data.thisMonth.bookStatus} flagged={data.thisMonth.flagged} />
        </section>

        {/* Section 3 — Weekly history */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-gray-500 font-medium mb-3">Recent Activity</h2>
          <WeeklyTable rows={data.weeklyHistory} />
        </section>
      </main>

      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header / Footer
// ---------------------------------------------------------------------------

function Header({ data }: { data?: PortalData } = {}) {
  return (
    <header className="bg-[#0F1E38] text-white">
      <div className="max-w-5xl mx-auto px-5 sm:px-8 py-6">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="text-xl font-bold tracking-tight">
              Ledgerix<span className="text-[#F5A623]">Pro</span>
            </div>
            {data && (
              <div className="mt-3">
                <div className="text-lg font-semibold leading-tight">{data.contactName || "Your account"}</div>
                {data.companyName && <div className="text-sm text-white/60">{data.companyName}</div>}
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            {data?.serviceTier && (
              <span className="inline-block rounded-full px-3 py-1 text-xs font-bold tracking-wider font-mono border border-[#F5A623]/40 text-[#F5A623] bg-[#F5A623]/10">
                {data.serviceTier.toUpperCase()}
              </span>
            )}
            <div className="text-xs uppercase tracking-widest text-white/50">Your Books</div>
          </div>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="max-w-5xl mx-auto px-5 sm:px-8 py-12 mt-12 border-t border-gray-200 text-center">
      <p className="text-sm text-gray-600">
        Questions? Reply to your weekly digest email or contact{" "}
        <a href="mailto:scott@ledgerixpro.com" className="text-[#F5A623] hover:underline">
          scott@ledgerixpro.com
        </a>
        .
      </p>
      <div className="mt-4 flex items-center justify-center gap-4 text-xs text-gray-500">
        <a href="/privacy-policy.html" className="hover:text-[#F5A623]">
          Privacy Policy
        </a>
        <span>·</span>
        <a href="/terms-of-service.html" className="hover:text-[#F5A623]">
          Terms of Service
        </a>
      </div>
      <p className="mt-6 text-xs text-gray-400">
        Powered by Ledgerix<span className="text-[#F5A623]">Pro</span>
      </p>
    </footer>
  );
}
