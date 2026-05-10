import { useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types — must match server/src/routes/ledgerix-dashboard.ts response shape
// ---------------------------------------------------------------------------

interface ClientSummary {
  contactId: string;
  contactName: string;
  companyName: string | null;
  serviceTier: string | null;
  platform: string | null;
  lastRunAt: string | null;
  transactionsToday: number | null;
  autoCategorized: number | null;
  flagged: number;
  reconciled: number | null;
  hitlPending: boolean;
}

interface HitlItem {
  issueId: string;
  title: string;
  contactName: string | null;
  agentName: string;
  priority: string;
  createdAt: string;
  ageHours: number;
}

interface AgentHealth {
  agentName: string;
  lastRunAt: string | null;
  runsToday: number;
  timeoutCount: number;
  issuesOpen: number;
  issuesDone: number;
  status: "idle" | "active" | "degraded";
}

interface SummaryResponse {
  generatedAt: string;
  clients: ClientSummary[];
  hitlQueue: HitlItem[];
  agentHealth: AgentHealth[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECRET_STORAGE_KEY = "ledgerix_dashboard_secret";
const REFRESH_INTERVAL_MS = 30_000;
const PAPERCLIP_BASE = "http://localhost:3100";
const ISSUE_PREFIX = "LED";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function statusTone(status: AgentHealth["status"]): { color: string; label: string } {
  switch (status) {
    case "degraded":
      return { color: "#F5A623", label: "DEGRADED" };
    case "active":
      return { color: "#10b981", label: "ACTIVE" };
    default:
      return { color: "#10b981", label: "IDLE" };
  }
}

function priorityTone(p: string): string {
  if (p === "urgent") return "#ef4444";
  if (p === "high") return "#F5A623";
  return "rgba(255,255,255,0.5)";
}

function issueUrl(issueId: string): string {
  return `${PAPERCLIP_BASE}/${ISSUE_PREFIX}/issues/${issueId}`;
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

function SecretPrompt({ onSubmit, error }: { onSubmit: (s: string) => void; error: string | null }) {
  const [value, setValue] = useState("");
  return (
    <div className="min-h-screen bg-[#0F1E38] text-white flex items-center justify-center font-sans">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
        className="w-full max-w-sm px-6"
      >
        <div className="text-center mb-8">
          <span className="text-xl font-bold tracking-tight">
            Ledgerix<span className="text-[#F5A623]">Pro</span>
          </span>
          <p className="mt-2 text-xs uppercase tracking-widest text-white/50">Operations</p>
        </div>
        <label className="block text-sm font-medium mb-2 text-white/80">Dashboard secret</label>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md bg-white/5 border border-white/10 px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#F5A623]/60"
          placeholder="Paste DASHBOARD_SECRET"
        />
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          className="w-full mt-4 rounded-md bg-[#F5A623] text-[#0F1E38] font-bold py-2 text-sm hover:bg-[#e8971e] transition-colors"
        >
          Unlock
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ title, accessory }: { title: string; accessory?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between mb-3">
      <h2 className="text-xs uppercase tracking-widest text-[#F5A623]/80">{title}</h2>
      {accessory}
    </div>
  );
}

function StatusBadge({ status }: { status: AgentHealth["status"] }) {
  const { color, label } = statusTone(status);
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider font-mono border"
      style={{ color, borderColor: `${color}66`, backgroundColor: `${color}1A` }}
    >
      {label}
    </span>
  );
}

function AgentCard({ a }: { a: AgentHealth }) {
  const { color } = statusTone(a.status);
  const borderClass =
    a.status === "degraded"
      ? "border-[#F5A623]/50"
      : "border-white/10 hover:border-white/20";
  return (
    <div
      className={`bg-white/5 border ${borderClass} rounded-lg p-4 transition-colors`}
      style={a.status === "degraded" ? { boxShadow: `0 0 0 1px ${color}33` } : undefined}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="text-sm font-semibold leading-tight">{a.agentName}</div>
        <StatusBadge status={a.status} />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <div className="text-white/50">Last run</div>
        <div className="font-mono text-right">{relativeTime(a.lastRunAt)}</div>
        <div className="text-white/50">Runs today</div>
        <div className="font-mono text-right">{a.runsToday}</div>
        <div className="text-white/50">Open / Done</div>
        <div className="font-mono text-right">
          {a.issuesOpen} / {a.issuesDone}
        </div>
        <div className="text-white/50">Timeouts</div>
        <div
          className="font-mono text-right"
          style={a.timeoutCount > 0 ? { color: "#F5A623" } : undefined}
        >
          {a.timeoutCount}
        </div>
      </div>
    </div>
  );
}

function HitlEmpty() {
  return (
    <div className="bg-white/5 border border-white/10 rounded-lg p-8 text-center">
      <div className="text-3xl mb-2 text-[#10b981]">✓</div>
      <p className="text-sm text-white/60">No items pending review</p>
    </div>
  );
}

function HitlTable({ rows }: { rows: HitlItem[] }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-[10px] uppercase tracking-widest text-white/50">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Title</th>
            <th className="text-left px-4 py-2 font-medium">Client</th>
            <th className="text-left px-4 py-2 font-medium">Agent</th>
            <th className="text-left px-4 py-2 font-medium">Priority</th>
            <th className="text-right px-4 py-2 font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.issueId}
              className="border-t border-white/5 hover:bg-white/5 cursor-pointer transition-colors"
              onClick={() => window.open(issueUrl(r.issueId), "_blank", "noopener,noreferrer")}
            >
              <td className="px-4 py-2.5 truncate max-w-[260px]" title={r.title}>{r.title}</td>
              <td className="px-4 py-2.5 text-white/70">{r.contactName ?? "—"}</td>
              <td className="px-4 py-2.5 text-white/70 font-mono text-xs">{r.agentName}</td>
              <td className="px-4 py-2.5">
                <span
                  className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider font-mono"
                  style={{ color: priorityTone(r.priority), borderColor: `${priorityTone(r.priority)}66` }}
                >
                  {r.priority.toUpperCase()}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-xs">{r.ageHours}h ago</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClientCard({ c }: { c: ClientSummary }) {
  const flagged = c.flagged > 0;
  const borderClass = flagged
    ? "border-[#F5A623]/50"
    : "border-white/10 hover:border-white/20";
  return (
    <div
      className={`bg-white/5 border ${borderClass} rounded-lg p-4 transition-colors`}
      style={flagged ? { boxShadow: "0 0 0 1px #F5A62333" } : undefined}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-sm font-semibold">{c.contactName || "—"}</div>
          {c.companyName && <div className="text-xs text-white/50">{c.companyName}</div>}
        </div>
        {c.serviceTier && (
          <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider font-mono border border-[#F5A623]/40 text-[#F5A623] bg-[#F5A623]/10">
            {c.serviceTier.toUpperCase()}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <div className="text-white/50">Platform</div>
        <div className="font-mono text-right">{c.platform ?? "—"}</div>
        <div className="text-white/50">Last run</div>
        <div className="font-mono text-right">{relativeTime(c.lastRunAt)}</div>
        <div className="text-white/50">Flagged</div>
        <div
          className="font-mono text-right"
          style={flagged ? { color: "#F5A623" } : undefined}
        >
          {c.flagged}
        </div>
      </div>
    </div>
  );
}

function ClientsEmpty() {
  return (
    <div className="bg-white/5 border border-white/10 rounded-lg p-8 text-center">
      <p className="text-sm text-white/60">
        No active clients yet — tag a contact <span className="font-mono text-[#F5A623]">client-active</span> in GHL to begin.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function LedgerixDashboard() {
  const [secret, setSecret] = useState<string | null>(() =>
    typeof window !== "undefined" ? sessionStorage.getItem(SECRET_STORAGE_KEY) : null,
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshTick, setLastRefreshTick] = useState(0);

  // Re-render every 10s so "X ago" timestamps stay fresh between fetches
  useEffect(() => {
    const id = window.setInterval(() => setLastRefreshTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Data fetch + auto-refresh
  useEffect(() => {
    if (!secret) return;
    let cancelled = false;

    const fetchData = async () => {
      setRefreshing(true);
      try {
        const res = await fetch("/api/dashboard/summary", {
          headers: { "X-Dashboard-Secret": secret },
        });
        if (cancelled) return;
        if (res.status === 401) {
          sessionStorage.removeItem(SECRET_STORAGE_KEY);
          setSecret(null);
          setAuthError("Invalid secret");
          return;
        }
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as SummaryResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };

    fetchData();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") fetchData();
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [secret]);

  const updatedLabel = useMemo(() => {
    if (!data) return "—";
    return relativeTime(data.generatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lastRefreshTick]);

  const handleSubmitSecret = (s: string) => {
    sessionStorage.setItem(SECRET_STORAGE_KEY, s);
    setSecret(s);
    setAuthError(null);
    setError(null);
  };

  if (!secret) return <SecretPrompt onSubmit={handleSubmitSecret} error={authError} />;

  return (
    <div className="h-screen overflow-y-auto bg-[#0F1E38] text-white font-sans">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[#0F1E38]/95 backdrop-blur border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <span className="text-lg font-bold tracking-tight">
              Ledgerix<span className="text-[#F5A623]">Pro</span>
              <span className="ml-2 text-white/50 font-normal text-sm">— Operations</span>
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono text-white/60">
            <span>Auto-refresh 30s</span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{
                  backgroundColor: refreshing ? "#10b981" : "rgba(255,255,255,0.3)",
                  boxShadow: refreshing ? "0 0 6px #10b98180" : undefined,
                  transition: "box-shadow 0.3s ease",
                }}
              />
              Updated {updatedLabel}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-8">
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
            Error fetching dashboard: {error}
          </div>
        )}

        {/* Section 1 — Agent Health */}
        <section>
          <SectionHeader
            title="Agent Health"
            accessory={
              data && (
                <span className="text-xs font-mono text-white/40">
                  {data.agentHealth.length} agents
                </span>
              )
            }
          />
          {!data ? (
            <div className="text-sm text-white/40">Loading…</div>
          ) : data.agentHealth.length === 0 ? (
            <div className="bg-white/5 border border-white/10 rounded-lg p-8 text-center text-sm text-white/60">
              No agents configured
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {data.agentHealth.map((a) => (
                <AgentCard key={a.agentName} a={a} />
              ))}
            </div>
          )}
        </section>

        {/* Section 2 — HITL Queue */}
        <section>
          <SectionHeader
            title="HITL Queue — Senior Bookkeeper"
            accessory={
              data && (
                <span className="text-xs font-mono text-white/40">
                  {data.hitlQueue.length} pending
                </span>
              )
            }
          />
          {!data ? (
            <div className="text-sm text-white/40">Loading…</div>
          ) : data.hitlQueue.length === 0 ? (
            <HitlEmpty />
          ) : (
            <HitlTable rows={data.hitlQueue} />
          )}
        </section>

        {/* Section 3 — Active Clients */}
        <section>
          <SectionHeader
            title="Active Clients"
            accessory={
              data && (
                <span className="text-xs font-mono text-white/40">
                  {data.clients.length} active
                </span>
              )
            }
          />
          {!data ? (
            <div className="text-sm text-white/40">Loading…</div>
          ) : data.clients.length === 0 ? (
            <ClientsEmpty />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.clients.map((c) => (
                <ClientCard key={c.contactId} c={c} />
              ))}
            </div>
          )}
        </section>

        <p className="text-center text-white/20 text-xs pt-8">
          © {new Date().getFullYear()} Ledgerix Pro LLC · Internal Operations
        </p>
      </main>
    </div>
  );
}
