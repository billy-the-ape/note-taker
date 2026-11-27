/**
 * Renders the settings screen the way the application does: the shared `ApiClient` seam, a
 * `QueryClient` built by the production factory, the root-level theme effects, and (for the
 * round-trip test) an editor open beside it.
 *
 * A fresh {@link createQueryClient} per render is the point — the cache is the only thing that
 * connects the screen to a consumer, so a test that shared one across cases would pass for the wrong
 * reason. "Reload" is modelled the honest way too: {@link reload} drops the `QueryClient` (a reload
 * is a new document, and a server-rendered cache is not in this app) and renders again against the
 * same fake server, which is what proves a value was *stored* rather than merely remembered by a
 * component.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsEffects } from '../features/settings/settings-effects.js';
import { SettingsPage } from '../features/settings/settings-page.js';
import { ApiClientProvider } from '../lib/api-client-context.js';
import { createQueryClient } from '../lib/queryClient.js';
import { EditorHarness } from './editor-harness.js';
import { createFakeServer, type FakeServer, type FakeTab, type FakeTabOptions } from './fake-api.js';

export interface RenderSettingsOptions {
  /** Defaults to a server with one signed-in owner and no settings row yet. */
  readonly server?: FakeServer;
  /** A tab to render in. Defaults to a new one, already signed in. */
  readonly tab?: FakeTab;
  /** Renders PR-14's stand-in next to the screen, reading the same cache. */
  readonly withEditor?: boolean;
  /** What the stand-in's save call would be; a spy in every test that asserts on writes. */
  readonly save?: (content: string) => void;
  /** Set when the test is about the theme: the operating system's preference at mount. */
  readonly prefersDark?: boolean;
  /**
   * @internal Passed down by {@link reload} so the recorded expiry events survive re-rendering the
   * same document. Do not set this by hand.
   */
  readonly expiry?: ExpiryRecord;
}

/**
 * The tab's `onUnauthorized` sink, shaped like production but recording instead of acting.
 *
 * In the browser, `lib/api.ts`'s 401 hook is installed by `features/auth/session.tsx`, which clears
 * the session cache and navigates. Neither is worth re-implementing here — PR-08's own tests cover
 * what the handler *does* — but the *decision about which `401`s reach it* is exactly what a settings
 * test has to be able to observe, and a client built without the hook cannot observe it at all:
 * `change-password.test.tsx` once passed a wrong current password while production would have signed
 * the person out, because nothing was listening. So a tab created by this harness always has a hook,
 * and it counts.
 */
export interface ExpiryRecord {
  /** One entry per `401` that reached the app-wide hook, as `<status> <code>`. */
  readonly events: string[];
}

export interface RenderSettingsResult {
  readonly view: RenderResult;
  readonly server: FakeServer;
  readonly tab: FakeTab;
  readonly queryClient: ReturnType<typeof createQueryClient>;
  /**
   * The `401`s this document handed to the app-wide expiry hook — the app-wide "the session is gone"
   * verdict. `0` after a failed password change is the assertion that a wrong current password is
   * about the password, not the session (`lib/api.ts`'s `isCredentialOnly401`).
   */
  expiryEvents(): readonly string[];
  /** Signs the user in on a second tab, i.e. the same account in another browser tab. */
  otherTab(name?: string): FakeTab;
  /** Throws away this document and renders a new one against the same fake server. */
  reload(): RenderSettingsResult;
}

export function renderSettings(options: RenderSettingsOptions = {}): RenderSettingsResult {
  const server = options.server ?? createFakeServer();
  const expiry: ExpiryRecord = options.expiry ?? { events: [] };
  const tab =
    options.tab ??
    signInOn(server, 'tab A', {
      onUnauthorized: (error) => {
        expiry.events.push(`${error.status} ${error.code}`);
      },
    });

  const queryClient = createQueryClient();

  const tree = (
    <ApiClientProvider client={tab.client}>
      <QueryClientProvider client={queryClient}>
        <SettingsEffects />
        <SettingsPage />
        {options.withEditor === true ? (
          <EditorHarness
            save={
              options.save ??
              (() => {
                throw new Error('the harness was asked to save without a save spy');
              })
            }
          />
        ) : null}
      </QueryClientProvider>
    </ApiClientProvider>
  );

  const view = render(tree as ReactNode);

  function reload(): RenderSettingsResult {
    // A new `QueryClient` and a fresh render against the same fake server and the same cookie jar:
    // the settings row has to come back over the wire, because that is all a reload is.
    view.unmount();
    return renderSettings({ ...options, server, tab, expiry });
  }

  return {
    view,
    server,
    tab,
    queryClient,
    expiryEvents: () => [...expiry.events],
    otherTab: (name = 'tab B') => signInOn(server, name),
    reload,
  };
}

/**
 * What `POST /api/auth/login` would have done to a fresh tab's cookie jar. `options` reaches
 * {@link FakeServer.tab}: pass `onUnauthorized` for the half of production that installs the 401 hook.
 */
export function signInOn(server: FakeServer, name: string, options?: FakeTabOptions): FakeTab {
  const tab = server.tab(name, options);
  server.signInTab(tab);
  return tab;
}
