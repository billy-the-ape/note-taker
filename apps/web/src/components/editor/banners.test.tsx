// @vitest-environment jsdom
/**
 * The two unsaved-work banners and the draft prompt (docs/plans/mvp/MVP-14.md §6).
 *
 * What is worth testing here is the shape of the choice, because the whole point of these components is
 * that they *refuse* to decide: a `VERSION_CONFLICT` must offer keep-mine, use-server and copy — and
 * must not label itself "saved", "restored", or anything else that implies an outcome. The `404` banner
 * must offer a **new** note and never the word "keep mine", because that is the difference between an
 * escape hatch and the silent re-create §4 forbids. Everything below that — the merge, the diff — is
 * backlog PR-25, and these components are deliberately too small to pretend otherwise.
 *
 * The clipboard is tested in both directions: the API that rejects is a normal browser state, and a
 * banner whose only exit is a call that may throw would strand somebody with the server's text on
 * screen. That is why the text is always in the document, whatever the clipboard did.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConflictBanner, copyServerText, DeletedNoteBanner } from './ConflictBanner';
import { DraftPrompt } from './DraftPrompt';

const SERVER = 'what the other tab saved';

/** The clipboard, installed or taken away: jsdom ships neither, and both states are real browsers. */
function withClipboard(clipboard: Clipboard | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
}

afterEach(() => {
  withClipboard(undefined);
});

describe('ConflictBanner (§6)', () => {
  function renderBanner() {
    const onKeepMine = vi.fn();
    const onUseServer = vi.fn();
    render(
      <ConflictBanner
        serverContent={SERVER}
        serverVersion={9}
        onKeepMine={onKeepMine}
        onUseServer={onUseServer}
      />,
    );
    return { onKeepMine, onUseServer };
  }

  it('offers three ways out, says nothing was overwritten, and shows the server’s copy', () => {
    renderBanner();

    const banner = screen.getByTestId('conflict-banner');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('nothing has been overwritten');
    expect(screen.getByTestId('conflict-server-version').textContent).toBe('v9');
    expect(screen.getByTestId('conflict-keep-mine').textContent).toBe('Keep mine');
    expect(screen.getByTestId('conflict-use-server').textContent).toBe('Use server');
    expect(screen.getByTestId('conflict-copy-server').textContent).toBe('Copy server text');
    // The fallback that makes the clipboard a convenience: the text is in the document either way.
    expect(screen.getByTestId('conflict-server-text').textContent).toBe(SERVER);
  });

  it('routes the two decisions to the two callbacks, and only to those', async () => {
    const { onKeepMine, onUseServer } = renderBanner();

    await userEvent.click(screen.getByTestId('conflict-keep-mine'));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
    expect(onUseServer).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('conflict-use-server'));
    expect(onUseServer).toHaveBeenCalledTimes(1);
    expect(onKeepMine).toHaveBeenCalledTimes(1);
  });

  it('hands the server’s text to the clipboard when the browser lets it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard({ writeText } as unknown as Clipboard);
    renderBanner();

    await userEvent.click(screen.getByTestId('conflict-copy-server'));

    expect(writeText).toHaveBeenCalledWith(SERVER);
    expect(screen.queryByTestId('conflict-copy-failed')).toBeNull();
  });

  it('says so when the clipboard refuses, without hiding the text it could not copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('the document is not focused'));
    withClipboard({ writeText } as unknown as Clipboard);
    renderBanner();

    await userEvent.click(screen.getByTestId('conflict-copy-server'));

    const notice = await screen.findByTestId('conflict-copy-failed');
    expect(notice.textContent).toContain('clipboard');
    expect(screen.getByTestId('conflict-server-text').textContent).toBe(SERVER);
  });

  it('reports a clipboard that does not exist as a failure rather than a success', async () => {
    withClipboard(undefined);
    // Present-but-useless and absent-but-honest have to land in the same place, or a banner on http
    // would claim it had copied something.
    await expect(copyServerText(SERVER)).resolves.toBe(false);
  });
});

describe('DeletedNoteBanner (§4’s 404 row)', () => {
  it('offers a new note, and only a new note', async () => {
    const onSaveAsNewNote = vi.fn().mockResolvedValue(undefined);
    render(<DeletedNoteBanner onSaveAsNewNote={onSaveAsNewNote} />);

    const banner = screen.getByTestId('deleted-note-banner');
    expect(banner.textContent).toContain('autosave has stopped');
    expect(screen.getByTestId('deleted-note-save-as-new').textContent).toBe('Save as a new note');
    // The distinction a reviewer should be able to grep for: nothing here says "keep mine".
    expect(screen.queryByTestId('conflict-keep-mine')).toBeNull();

    await userEvent.click(screen.getByTestId('deleted-note-save-as-new'));
    expect(onSaveAsNewNote).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('deleted-note-save-failed')).toBeNull();
  });

  it('says when the escape hatch itself failed, which is the moment to copy the text out by hand', async () => {
    const onSaveAsNewNote = vi.fn().mockRejectedValue(new Error('the session went away'));
    render(<DeletedNoteBanner reason="note not found" onSaveAsNewNote={onSaveAsNewNote} />);

    await userEvent.click(screen.getByTestId('deleted-note-save-as-new'));

    const notice = await screen.findByTestId('deleted-note-save-failed');
    expect(notice.textContent).toContain('copy your text');
    expect(screen.getByTestId('deleted-note-banner').textContent).toContain('note not found');
  });
});

describe('DraftPrompt (§6’s restore prompt)', () => {
  it('shows what was kept and offers exactly the two choices', async () => {
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    render(<DraftPrompt content={'a paragraph a crash kept'} onRestore={onRestore} onDiscard={onDiscard} />);

    expect(screen.getByTestId('draft-text').textContent).toBe('a paragraph a crash kept');
    expect(screen.getByTestId('draft-prompt').textContent).toContain('never finished saving');

    await userEvent.click(screen.getByTestId('draft-restore'));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('throws the draft away through its own callback, which is the only way it stops asking', async () => {
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    render(<DraftPrompt content="old text" onRestore={onRestore} onDiscard={onDiscard} />);

    await userEvent.click(screen.getByTestId('draft-discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
  });
});
