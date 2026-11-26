/**
 * The two banners an unsaved buffer can be stuck behind (docs/plans/mvp/MVP-14.md §6).
 *
 * **`ConflictBanner`** is what a `VERSION_CONFLICT` arrives as — and only ever as this, because §5
 * established that a conflict shown for a write that actually landed is worse than no banner at all.
 * Three actions, and none of them is "OK": *Keep mine* writes the retained buffer against the fresh
 * server `version`, *Use server* replaces the buffer with the payload and takes the `localStorage`
 * mirror with it, and *Copy server text* exists because the honest third option in a merge is "I will
 * read both and decide", which no two-button dialog can offer. A real three-way merge is backlog
 * PR-25; this is the UI that makes waiting for it safe.
 *
 * **`DeletedNoteBanner`** is the `404` row of §4: the note was deleted elsewhere, autosave stopped,
 * and the escape hatch is a **new** note. It gets its own component precisely because the two states
 * must not be confusable — a banner that offered "keep mine" for a note that no longer exists would be
 * the silent re-create §4 forbids.
 *
 * Autosave is paused while either is up, and that pause is the machine's, not this file's: nothing
 * here schedules a write.
 */
import { useState } from 'react';

import { Button } from '../ui/Button';

export interface ConflictBannerProps {
  /** `data.version` from the `VERSION_CONFLICT` payload (§9.2 #18). */
  readonly serverVersion: number;
  /** `data.content`, the row that beat this write, as plaintext — the seal is randomized, so this is
   * the only form in which two versions of a note can be compared at all (§5). */
  readonly serverContent: string;
  readonly onKeepMine: () => void;
  readonly onUseServer: () => void;
}

/**
 * The clipboard, best-effort.
 *
 * `navigator.clipboard` is missing outright on http origins in some browsers and present but
 * permission-rejected in others, and a banner whose only copy path is an API that may throw would
 * strand a person with the server's text on screen and no way to move it. So the failure is a message,
 * and the text is always selectable below regardless of whether the clipboard worked.
 */
export async function copyServerText(content: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(content);
    return true;
  } catch {
    return false;
  }
}

export function ConflictBanner({
  serverVersion,
  serverContent,
  onKeepMine,
  onUseServer,
}: ConflictBannerProps) {
  const [clipboardFailed, setClipboardFailed] = useState(false);

  async function onCopy(): Promise<void> {
    setClipboardFailed(!(await copyServerText(serverContent)));
  }

  return (
    <div
      data-testid="conflict-banner"
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger-soft p-3"
    >
      <p className="text-sm font-medium text-ink">
        Someone saved this note first — your text is not saved, and nothing has been overwritten.
      </p>
      <p className="text-sm text-ink-muted">
        The version on the server is{' '}
        <span data-testid="conflict-server-version" className="font-mono">
          v{serverVersion}
        </span>
        . Choose which copy wins, or copy the server text and put the two together yourself.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" data-testid="conflict-keep-mine" onClick={onKeepMine}>
          Keep mine
        </Button>
        <Button variant="secondary" size="sm" data-testid="conflict-use-server" onClick={onUseServer}>
          Use server
        </Button>
        <Button variant="ghost" size="sm" data-testid="conflict-copy-server" onClick={() => void onCopy()}>
          Copy server text
        </Button>
      </div>

      {clipboardFailed ? (
        <p data-testid="conflict-copy-failed" className="text-sm text-danger">
          The clipboard refused that — select the text below and copy it yourself.
        </p>
      ) : null}

      {/* Not a preview for its own sake: it is the fallback that makes the clipboard a convenience
          rather than the only door out. */}
      <details className="text-sm text-ink-muted">
        <summary className="cursor-pointer select-none">Show the server text</summary>
        <pre
          data-testid="conflict-server-text"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono"
        >
          {serverContent}
        </pre>
      </details>
    </div>
  );
}

export interface DeletedNoteBannerProps {
  /** Why autosave stopped, in the machine's words (§4: `404`, never a silent re-create). */
  readonly reason?: string;
  /**
   * Creates a new note from the retained buffer. The caller owns navigating to it; a rejection shows
   * the banner's failure line.
   */
  readonly onSaveAsNewNote: () => Promise<void>;
}

/** The `404` row of §4, as a banner: the text is still here, the note is not. */
export function DeletedNoteBanner({ reason, onSaveAsNewNote }: DeletedNoteBannerProps) {
  const [failed, setFailed] = useState(false);

  async function onSave(): Promise<void> {
    try {
      setFailed(false);
      await onSaveAsNewNote();
    } catch {
      setFailed(true);
    }
  }

  return (
    <div
      data-testid="deleted-note-banner"
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger-soft p-3"
    >
      <p className="text-sm font-medium text-ink">
        This note was deleted elsewhere, so autosave has stopped.
      </p>
      <p className="text-sm text-ink-muted">
        Your text is still in this tab. Saving it again would create a note, so it will only happen if you ask
        for one.{reason === undefined ? '' : ` (${reason})`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="deleted-note-save-as-new"
          onClick={() => void onSave()}
        >
          Save as a new note
        </Button>
      </div>
      {failed ? (
        <p data-testid="deleted-note-save-failed" className="text-sm text-danger">
          That did not work — copy your text out of the editor before you close this tab.
        </p>
      ) : null}
    </div>
  );
}
