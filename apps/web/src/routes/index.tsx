import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

/**
 * The placeholder home page (plan §11.1).
 *
 * PR-08 replaces this route with the redirect rule (signed out → `/login`, first run → `/setup`,
 * signed in → `/welcome`), and PR-12 with the app shell. What it does prove today is the two
 * halves of PR-01: the SPA renders, and `/api` is proxied to the API process — the badge below is
 * the same `GET /api/health` the acceptance criteria curl.
 */
export const Route = createFileRoute('/')({
  component: ComingSoon,
});

interface HealthResponse {
  readonly status: string;
  readonly db: string;
  readonly version: string;
}

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  if (!response.ok) {
    throw new Error(`GET /api/health responded ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

function ComingSoon() {
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium tracking-wide text-brand uppercase">Note Taker</p>
        <h1 className="text-3xl font-semibold">Coming soon</h1>
      </header>

      <p className="text-ink-muted">
        The scaffold is up: Fastify on the API, React on the front, and the quality gates wired into every
        commit. Folders, notes, the editor and the login screen arrive with the next pull requests.
      </p>

      <HealthBadge />
    </section>
  );
}

/** Reads the API through the Vite proxy, so a green badge means the dev pair is wired together. */
function HealthBadge() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
    refetchInterval: 5_000,
  });

  if (health.isPending) {
    return <StatusLine tone="muted" label="Checking the API…" />;
  }
  if (health.isError || health.data === undefined) {
    return (
      <StatusLine
        tone="warn"
        label="API unreachable — start it with `pnpm dev`, which runs Vite and the server together"
      />
    );
  }

  return <StatusLine tone="ok" label={`API is healthy (v${health.data.version})`} />;
}

function StatusLine({ tone, label }: { tone: 'ok' | 'warn' | 'muted'; label: string }) {
  const dot = tone === 'ok' ? 'bg-brand' : tone === 'warn' ? 'bg-amber-500' : 'bg-ink-muted';

  return (
    <p className="flex items-center gap-2 text-sm">
      <span aria-hidden className={`size-2 rounded-full ${dot}`} />
      <span className="text-ink-muted">{label}</span>
    </p>
  );
}
