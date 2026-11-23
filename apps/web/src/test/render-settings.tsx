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
import { createFakeServer, type FakeServer, type FakeTab } from './fake-api.js';

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
}

export interface RenderSettingsResult {
  readonly view: RenderResult;
  readonly server: FakeServer;
  readonly tab: FakeTab;
  readonly queryClient: ReturnType<typeof createQueryClient>;
  /** Signs the user in on a second tab, i.e. the same account in another browser tab. */
  otherTab(name?: string): FakeTab;
  /** Throws away this document and renders a new one against the same fake server. */
  reload(): RenderSettingsResult;
}

export function renderSettings(options: RenderSettingsOptions = {}): RenderSettingsResult {
  const server = options.server ?? createFakeServer();
  const tab = options.tab ?? signInOn(server, 'tab A');

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
    return renderSettings({ ...options, server, tab });
  }

  return {
    view,
    server,
    tab,
    queryClient,
    otherTab: (name = 'tab B') => signInOn(server, name),
    reload,
  };
}

/** What `POST /api/auth/login` would have done to a fresh tab's cookie jar. */
export function signInOn(server: FakeServer, name: string): FakeTab {
  const tab = server.tab(name);
  server.signInTab(tab);
  return tab;
}
