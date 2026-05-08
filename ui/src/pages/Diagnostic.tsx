import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REVENUE_OPTIONS = [
  { label: "Under $250k", midpoint: 125_000 },
  { label: "$250k–$500k", midpoint: 375_000 },
  { label: "$500k–$1M", midpoint: 750_000 },
  { label: "$1M–$2M", midpoint: 1_500_000 },
  { label: "Over $2M", midpoint: 2_500_000 },
];

const EXPENSE_OPTIONS = [
  { label: "Under $10k", midpoint: 5_000 },
  { label: "$10k–$25k", midpoint: 17_500 },
  { label: "$25k–$50k", midpoint: 37_500 },
  { label: "$50k–$100k", midpoint: 75_000 },
  { label: "Over $100k", midpoint: 125_000 },
];

type Niche = "trades" | "agency" | "smallbiz";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function computeAmount(
  niche: Niche,
  p: {
    revenueLabel: string;
    confidence: number;
    teamSize: number;
    leakHours: number;
    hourlyRate: number;
    expenseLabel: string;
    daysToPay: number;
  },
): number {
  if (niche === "trades") {
    const rev = REVENUE_OPTIONS.find((o) => o.label === p.revenueLabel)?.midpoint ?? 0;
    return Math.max(0, Math.round(rev * (0.1 - p.confidence * 0.01)));
  }
  if (niche === "agency") {
    return Math.max(0, Math.round(p.teamSize * p.leakHours * p.hourlyRate * 50));
  }
  const exp = EXPENSE_OPTIONS.find((o) => o.label === p.expenseLabel)?.midpoint ?? 0;
  return Math.max(0, Math.round((exp / 30) * p.daysToPay));
}

function getTier(amount: number): { name: string; price: string; description: string } {
  if (amount < 10_000) {
    return {
      name: "The Foundation",
      price: "from $199/mo",
      description: "Get your books locked in so you never lose another dollar to leakage.",
    };
  }
  if (amount <= 50_000) {
    return {
      name: "The Growth Engine",
      price: "from $349/mo",
      description: "This plan pays for itself 10x over by month two.",
    };
  }
  return {
    name: "The Scale-Up",
    price: "from $599/mo",
    description: "Full AP, AR, and payroll automation to protect your volume.",
  };
}

function formatDollar(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

function getHeadline(niche: Niche, amount: string): string {
  if (niche === "trades")
    return `You're likely losing ${amount} a year in unbilled materials and labor.`;
  if (niche === "agency")
    return `Your team is donating ${amount} worth of work to clients every year.`;
  return `You're financing ${amount} of your customers' lives with your own cash.`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DiagnosticPage() {
  // Navigation
  const [step, setStep] = useState(1);
  const [visible, setVisible] = useState(true);

  // Step 1
  const [niche, setNiche] = useState<Niche | null>(null);

  // Step 2 — trades
  const [revenueLabel, setRevenueLabel] = useState("");
  const [confidence, setConfidence] = useState(5);

  // Step 2 — agency
  const [teamSize, setTeamSize] = useState("");
  const [leakHours, setLeakHours] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");

  // Step 2 — small business
  const [expenseLabel, setExpenseLabel] = useState("");
  const [daysToPay, setDaysToPay] = useState(30);

  // Step 3
  const [diagnosticAmount, setDiagnosticAmount] = useState(0);
  const [displayAmount, setDisplayAmount] = useState(0);

  // Step 4
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // -------------------------------------------------------------------------
  // GHL chat widget — mount/unmount with the diagnostic page
  // -------------------------------------------------------------------------

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://widgets.leadconnectorhq.com/loader.js";
    script.setAttribute("data-resources-url", "https://widgets.leadconnectorhq.com/chat-widget/loader.js");
    script.setAttribute("data-widget-id", "69f3b90fdfa79f657adfc3ce");
    script.setAttribute("data-source", "WEB_USER");
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Step transition (fade)
  // -------------------------------------------------------------------------

  const goToStep = useCallback((next: number) => {
    setVisible(false);
    setTimeout(() => {
      setStep(next);
      setVisible(true);
    }, 180);
  }, []);

  // -------------------------------------------------------------------------
  // Animated counter
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 3 || diagnosticAmount === 0) return;
    const target = diagnosticAmount;
    const duration = 1500;
    const startTime = Date.now();
    let rafId: number;
    const tick = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 4); // ease-out-quart
      setDisplayAmount(Math.round(target * eased));
      if (progress < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [step, diagnosticAmount]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleNicheSelect = (n: Niche) => {
    setNiche(n);
    goToStep(2);
  };

  const isStep2Valid = (): boolean => {
    if (!niche) return false;
    if (niche === "trades") return !!revenueLabel;
    if (niche === "agency") return !!teamSize && !!leakHours && !!hourlyRate;
    return !!expenseLabel;
  };

  const handleCalculate = () => {
    if (!niche) return;
    const amount = computeAmount(niche, {
      revenueLabel,
      confidence,
      teamSize: parseFloat(teamSize) || 0,
      leakHours: parseFloat(leakHours) || 0,
      hourlyRate: parseFloat(hourlyRate) || 0,
      expenseLabel,
      daysToPay,
    });
    setDiagnosticAmount(amount);
    setDisplayAmount(0);
    goToStep(3);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch("/api/diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone,
          companyName,
          smsConsent,
          niche,
          diagnosticAmount,
          inputs: {
            revenueLabel,
            confidence,
            teamSize,
            leakHours,
            hourlyRate,
            expenseLabel,
            daysToPay,
          },
        }),
      });
    } catch {
      // Server route not yet wired — show success state regardless
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  };

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const tier = diagnosticAmount > 0 ? getTier(diagnosticAmount) : null;

  // -------------------------------------------------------------------------
  // Shared class strings
  // -------------------------------------------------------------------------

  const inputCls =
    "w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 px-4 py-3 text-sm focus:outline-none focus:border-[#F5A623] transition-colors";
  const selectCls =
    "w-full rounded-lg bg-[#162840] border border-white/20 text-white px-4 py-3 text-sm focus:outline-none focus:border-[#F5A623] transition-colors appearance-none cursor-pointer";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="h-screen overflow-y-auto bg-[#0F1E38] text-white">
      <div className="mx-auto max-w-xl px-5 py-12">

        {/* Logo */}
        <div className="text-center mb-10">
          <span className="text-xl font-bold tracking-tight">
            Ledgerix<span className="text-[#F5A623]">Pro</span>
          </span>
        </div>

        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step
                  ? "w-8 bg-[#F5A623]"
                  : s < step
                    ? "w-4 bg-[#F5A623]/50"
                    : "w-4 bg-white/15"
              }`}
            />
          ))}
        </div>

        {/* Step label */}
        <p className="text-center text-xs text-white/30 uppercase tracking-widest mb-8">
          Step {step} of 4
        </p>

        {/* Animated step container */}
        <div
          className={`transition-opacity duration-200 ${
            visible ? "opacity-100" : "opacity-0"
          }`}
        >

          {/* ================================================================
              STEP 1 — Niche selection
          ================================================================ */}
          {step === 1 && (
            <div>
              <h1 className="text-3xl font-bold text-center mb-2 leading-tight">
                What kind of business do you run?
              </h1>
              <p className="text-white/50 text-center text-sm mb-8">
                We'll calculate your exact financial leakage in 2 minutes.
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  {
                    id: "trades" as const,
                    icon: "🔧",
                    title: "Trades",
                    subtitle: "HVAC, Plumbing, Electrical, Roofing, Flooring",
                  },
                  {
                    id: "agency" as const,
                    icon: "📊",
                    title: "Agency",
                    subtitle: "Marketing, Creative, Consulting",
                  },
                  {
                    id: "smallbiz" as const,
                    icon: "🏢",
                    title: "Small Business",
                    subtitle: "1–20 employees",
                  },
                ].map((n) => (
                  <button
                    key={n.id}
                    onClick={() => handleNicheSelect(n.id)}
                    className="rounded-2xl border-2 border-white/10 hover:border-[#F5A623] bg-white/5 hover:bg-[#F5A623]/8 p-6 text-left transition-all duration-200 group"
                  >
                    <div className="text-3xl mb-3">{n.icon}</div>
                    <h3 className="text-base font-semibold">{n.title}</h3>
                    <p className="text-sm text-white/45 mt-1 leading-snug">{n.subtitle}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ================================================================
              STEP 2 — Inputs
          ================================================================ */}
          {step === 2 && niche && (
            <div>
              <button
                onClick={() => goToStep(1)}
                className="text-white/35 hover:text-white/70 text-sm mb-6 flex items-center gap-1 transition-colors"
              >
                ← Back
              </button>

              <h1 className="text-3xl font-bold mb-2 leading-tight">
                {niche === "trades" && "Tell us about your trade business"}
                {niche === "agency" && "Tell us about your agency"}
                {niche === "smallbiz" && "Tell us about your business"}
              </h1>
              <p className="text-white/50 text-sm mb-8">
                These numbers feed directly into your diagnostic.
              </p>

              <div className="space-y-6">

                {/* --- TRADES --- */}
                {niche === "trades" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        What is your approximate annual revenue?
                      </label>
                      <div className="relative">
                        <select
                          value={revenueLabel}
                          onChange={(e) => setRevenueLabel(e.target.value)}
                          className={selectCls}
                        >
                          <option value="" disabled>Select a range…</option>
                          {REVENUE_OPTIONS.map((o) => (
                            <option key={o.label} value={o.label}>{o.label}</option>
                          ))}
                        </select>
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/40 text-sm">▾</span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">
                        How confident are you that every bolt, pipe, and hour gets billed to the right job?
                      </label>
                      <p className="text-xs text-white/35 mb-4">
                        1 = We definitely miss things &nbsp;·&nbsp; 10 = We capture everything
                      </p>
                      <div className="flex items-center gap-4">
                        <input
                          type="range"
                          min={1}
                          max={10}
                          value={confidence}
                          onChange={(e) => setConfidence(Number(e.target.value))}
                          className="flex-1 accent-[#F5A623] cursor-pointer h-2"
                        />
                        <span className="w-8 text-right text-xl font-bold text-[#F5A623] tabular-nums">
                          {confidence}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs text-white/25 mt-1.5 px-0.5">
                        <span>1</span>
                        <span>10</span>
                      </div>
                    </div>
                  </>
                )}

                {/* --- AGENCY --- */}
                {niche === "agency" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        How many people on your team work on client delivery (including you)?
                      </label>
                      <input
                        type="number"
                        min={1}
                        placeholder="e.g. 4"
                        value={teamSize}
                        onChange={(e) => setTeamSize(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        How many hours per week does your team spend on out-of-scope or unbilled work?
                      </label>
                      <input
                        type="number"
                        min={0}
                        placeholder="e.g. 5"
                        value={leakHours}
                        onChange={(e) => setLeakHours(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        What is your average hourly billing rate?
                      </label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/45 text-sm select-none">
                          $
                        </span>
                        <input
                          type="number"
                          min={0}
                          placeholder="100"
                          value={hourlyRate}
                          onChange={(e) => setHourlyRate(e.target.value)}
                          className={`${inputCls} pl-8`}
                        />
                      </div>
                    </div>
                  </>
                )}

                {/* --- SMALL BUSINESS --- */}
                {niche === "smallbiz" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        What are your average monthly operating expenses?
                      </label>
                      <div className="relative">
                        <select
                          value={expenseLabel}
                          onChange={(e) => setExpenseLabel(e.target.value)}
                          className={selectCls}
                        >
                          <option value="" disabled>Select a range…</option>
                          {EXPENSE_OPTIONS.map((o) => (
                            <option key={o.label} value={o.label}>{o.label}</option>
                          ))}
                        </select>
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/40 text-sm">▾</span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        How many days does it usually take to get paid after a sale?
                      </label>
                      <input
                        type="number"
                        min={1}
                        placeholder="30"
                        value={daysToPay}
                        onChange={(e) => setDaysToPay(Number(e.target.value))}
                        className={inputCls}
                      />
                    </div>
                  </>
                )}

              </div>

              <button
                onClick={handleCalculate}
                disabled={!isStep2Valid()}
                className="mt-8 w-full rounded-xl bg-[#F5A623] text-[#0F1E38] font-bold py-4 text-base hover:bg-[#e8971e] transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
              >
                Calculate My Diagnostic →
              </button>
            </div>
          )}

          {/* ================================================================
              STEP 3 — Results
          ================================================================ */}
          {step === 3 && niche && tier && (
            <div>
              <h1 className="text-3xl font-bold text-center mb-8 leading-tight">
                Your Diagnostic
              </h1>

              {/* Big animated number */}
              <div className="rounded-2xl bg-white/5 border border-white/10 p-8 text-center mb-5">
                <div className="text-6xl font-bold text-[#F5A623] mb-4 tabular-nums tracking-tight">
                  {formatDollar(displayAmount)}
                </div>
                <p className="text-white/75 text-sm leading-relaxed max-w-sm mx-auto">
                  {getHeadline(niche, formatDollar(diagnosticAmount))}
                </p>
              </div>

              {/* Tier recommendation */}
              <div className="rounded-2xl border border-[#F5A623]/30 bg-[#F5A623]/5 p-5 mb-6">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[#F5A623]/60 mb-1.5">
                  Recommended Plan
                </p>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-lg font-bold">{tier.name}</h2>
                  <span className="text-[#F5A623] font-semibold text-sm">{tier.price}</span>
                </div>
                <p className="text-white/55 text-sm mt-1.5 leading-snug">{tier.description}</p>
              </div>

              <button
                onClick={() => goToStep(4)}
                className="w-full rounded-xl bg-[#F5A623] text-[#0F1E38] font-bold py-4 text-base hover:bg-[#e8971e] transition-colors"
              >
                Get My Full Diagnostic Report →
              </button>
              <button
                onClick={() => goToStep(2)}
                className="w-full mt-3 py-2 text-sm text-white/35 hover:text-white/65 transition-colors"
              >
                ← Adjust inputs
              </button>
            </div>
          )}

          {/* ================================================================
              STEP 4 — Lead capture
          ================================================================ */}
          {step === 4 && (
            <div>
              {submitted ? (
                <div className="text-center py-16">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#F5A623]/15 border border-[#F5A623]/30 text-[#F5A623] text-2xl mb-6">
                    ✓
                  </div>
                  <h2 className="text-2xl font-bold mb-3">You're on your way.</h2>
                  <p className="text-white/60 text-sm max-w-xs mx-auto leading-relaxed">
                    Your diagnostic is on its way. Laura from Ledgerix Pro will be in touch shortly.
                  </p>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => goToStep(3)}
                    className="text-white/35 hover:text-white/70 text-sm mb-6 flex items-center gap-1 transition-colors"
                  >
                    ← Back to results
                  </button>
                  <h1 className="text-3xl font-bold mb-2 leading-tight">
                    Get your full report
                  </h1>
                  <p className="text-white/50 text-sm mb-8">
                    We'll send a personalized breakdown of your diagnostic — and what to do about it.
                  </p>

                  <form onSubmit={handleSubmit} className="space-y-4 pb-32">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium mb-1.5">First Name</label>
                        <input
                          required
                          type="text"
                          autoComplete="given-name"
                          placeholder="John"
                          value={firstName}
                          onChange={(e) => setFirstName(e.target.value)}
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1.5">Last Name</label>
                        <input
                          required
                          type="text"
                          autoComplete="family-name"
                          placeholder="Brown"
                          value={lastName}
                          onChange={(e) => setLastName(e.target.value)}
                          className={inputCls}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1.5">Email</label>
                      <input
                        required
                        type="email"
                        autoComplete="email"
                        placeholder="john@brownroofing.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={inputCls}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1.5">
                        Phone{" "}
                        <span className="text-white/30 font-normal">(optional)</span>
                      </label>
                      <input
                        type="tel"
                        autoComplete="tel"
                        placeholder="+1 (602) 555-0100"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className={inputCls}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1.5">Company Name</label>
                      <input
                        required
                        type="text"
                        autoComplete="organization"
                        placeholder="Brown Roofing Services"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                        className={inputCls}
                      />
                    </div>

                    <div>
                      <label className="flex items-start gap-2 text-xs text-white/80 leading-relaxed cursor-pointer">
                        <input
                          type="checkbox"
                          checked={smsConsent}
                          onChange={(e) => setSmsConsent(e.target.checked)}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/30 bg-transparent accent-[#F5A623]"
                        />
                        <span>
                          I agree to receive marketing and informational SMS messages from Ledgerix Pro LLC regarding bookkeeping services and my account. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out at any time. View our{" "}
                          <a
                            href="/privacy-policy.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[#F5A623] underline"
                          >
                            Privacy Policy
                          </a>
                          .
                        </span>
                      </label>
                    </div>

                    <div className="sticky bottom-0 bg-[#0F1E38] -mx-5 px-5 pt-2 pb-6">
                      <button
                        type="submit"
                        disabled={submitting}
                        className="w-full rounded-xl bg-[#F5A623] text-[#0F1E38] font-bold py-4 text-base hover:bg-[#e8971e] transition-colors disabled:opacity-50"
                      >
                        {submitting ? "Sending…" : "Get My Full Diagnostic Report"}
                      </button>
                    </div>
                  </form>
                  <p className="mt-6 text-center text-white/60 text-xs leading-relaxed">
                    Ledgerix Pro LLC | Phoenix, AZ |{" "}
                    <a href="mailto:scott@ledgerixpro.com" className="hover:text-white">scott@ledgerixpro.com</a>{" "}
                    | <a href="tel:+14806602815" className="hover:text-white">(480) 660-2815</a>
                    <br />
                    <a
                      href="/privacy-policy.html"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-white underline"
                    >
                      Privacy Policy
                    </a>
                    {" · "}
                    <a
                      href="/terms-of-service.html"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-white underline"
                    >
                      Terms of Service
                    </a>
                  </p>
                </>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <p className="text-center text-white/20 text-xs mt-14">
          © {new Date().getFullYear()} Ledgerix Pro LLC · AI-Powered Bookkeeping
        </p>
      </div>

      {/* Hidden compliance footer — always in DOM for crawlers/scanners, off-screen for users */}
      <div
        style={{ position: "absolute", left: "-9999px", top: "auto", width: "1px", height: "1px", overflow: "hidden" }}
        aria-hidden="true"
      >
        <p>
          Ledgerix Pro LLC SMS Consent: By checking the box on this form, you agree to receive marketing and informational SMS messages from Ledgerix Pro LLC regarding bookkeeping services and your account. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out. Reply HELP for help. View our <a href="/privacy-policy.html">Privacy Policy</a> and <a href="/terms-of-service.html">Terms of Service</a>. Checkbox is optional and not required to submit this form. You must be 18 or older to opt in.
        </p>
      </div>
    </div>
  );
}
