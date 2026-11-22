// @vitest-environment jsdom
/**
 * The kit every later PR builds with (docs/plans/mvp/MVP-08.md §7).
 *
 * The criteria worth dying on are in the markup rather than the pixels: a spinner that is `role="status"`
 * and named, a button that cannot be pressed twice while it is working, an input whose `aria-invalid`
 * matches the message under it, a label that is actually *for* the input, a dialog that owns focus and
 * closes on Escape, a toast that can be dismissed. Tailwind cannot be asserted in jsdom, so the colour
 * assertions are about the class names — which is also the honest version: what the dark theme hooks up
 * to later is those names, not their computed values.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle, DialogTrigger } from './Dialog';
import { describeBy, errorId, Field, FormMessage, hintId } from './Field';
import { Input } from './Input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './Menu';
import { LoadingBlock, Spinner } from './Spinner';
import { ToastProvider, useToast } from './Toast';

describe('Spinner', () => {
  it('is a live region whose accessible name says what is happening', () => {
    render(<Spinner label="Saving the note" />);
    const spinner = screen.getByRole('status');
    // No jest-dom here: the words live in the element's own text, which is what makes it a name.
    expect(spinner.textContent).toBe('Saving the note');
    // The whole trick: the words are always in the accessible name, and only sometimes on screen. The
    // `sr-only` class is the difference, so the assertion is about the class rather than the pixels.
    expect(screen.getByText('Saving the note').className).toContain('sr-only');
  });

  it('says its words out loud when asked, which is what a full-page wait wants', () => {
    render(<Spinner label="Loading your notes" showLabel />);
    expect(screen.getByText('Loading your notes').className).not.toContain('sr-only');
  });

  it('centers a labelled spinner for a page-length wait', () => {
    render(<LoadingBlock label="Checking whether you are still signed in…" />);
    const block = screen.getByText('Checking whether you are still signed in…').closest('div');
    expect(block?.className).toContain('items-center');
    expect(block?.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Button', () => {
  it('disables itself and announces busy work while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    // A `/Save/` rather than `'Save'`, and that is the point: the spinner's words join the accessible
    // name, so a busy button is announced as "Working Save" and not as an empty control.
    const button = screen.getByRole('button', { name: /Save/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Save');
    // Not "the handler is guarded" but "the click never happens": a disabled button is also what stops
    // the double-submit that PR-13's autosave would otherwise turn into two version bumps.
    await user.click(button).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.querySelector('[role="status"]')).not.toBeNull();
  });

  it('puts each intent on its own token', () => {
    render(
      <>
        <Button variant="primary">Save</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="danger">Delete</Button>
      </>,
    );
    // `bg-brand`, `border-line`, `bg-danger`: the names `styles/globals.css` re-points in the dark.
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('bg-brand');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('border-line');
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-danger');
    // Every one of them focus-ring-able, in the theme's colour rather than the browser default — and
    // the destructive one rings red, so the ring alone still distinguishes it.
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('focus-visible:ring-brand');
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('focus-visible:ring-danger');
  });

  it('lets a Radix trigger own it, which is what `asChild` composition needs', () => {
    // `DialogTrigger asChild` clones its props — including the ref — onto the child. That only works if
    // `Button` forwards both, which is why `ref` is a plain prop here (React 19) rather than a
    // `forwardRef`, and why a nested `<button>` never shows up in the tree.
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Rename</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Rename the note</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Rename' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.querySelector('button > button')).toBeNull();
  });
});

describe('Input', () => {
  it('is invalid only when it is, in the attribute and the token', () => {
    const { rerender } = render(<Input aria-label="Username" />);
    expect(screen.getByLabelText('Username').hasAttribute('aria-invalid')).toBe(false);

    rerender(<Input aria-label="Username" invalid />);
    const input = screen.getByLabelText('Username');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // The token names are the contract with `styles/globals.css`; `focus:ring-brand` is what the dark
    // theme re-points, so a rename here is a rename there.
    expect(input.className).toContain('border-danger');
    expect(input.className).toContain('focus:ring-brand');
  });
});

describe('Field', () => {
  it('binds the label to the input', () => {
    render(
      <Field label="Username" htmlFor="f-username">
        <Input id="f-username" />
      </Field>,
    );
    // `getByLabelText` is the assertion: if the `for`/`id` pair broke, this query finds nothing.
    expect((screen.getByLabelText('Username') as HTMLElement).id).toBe('f-username');
  });

  it('shows the error, and hides the hint it contradicts', () => {
    render(
      <Field label="Password" htmlFor="f-password" hint="At least 10 characters." error="too short">
        <Input id="f-password" />
      </Field>,
    );
    const error = screen.queryByText('too short');
    expect(error).not.toBeNull();
    expect(error?.id).toBe(errorId('f-password'));
    // Not merely hidden: the node is gone, so a reader cannot be told two opposite things about the
    // same box.
    expect(screen.queryByText('At least 10 characters.')).toBeNull();
  });

  it('points the input at whichever message is showing', () => {
    const { rerender } = render(
      <Field label="Password" htmlFor="f-password" hint="At least 10 characters.">
        <Input id="f-password" aria-describedby={describeBy('f-password', { hint: true })} />
      </Field>,
    );
    const hint = screen.getByLabelText('Password');
    expect(hint.getAttribute('aria-describedby')).toBe(hintId('f-password'));
    expect(document.getElementById(hintId('f-password'))?.textContent).toBe('At least 10 characters.');

    rerender(
      <Field label="Password" htmlFor="f-password" hint="At least 10 characters." error="too short">
        <Input id="f-password" aria-describedby={describeBy('f-password', { error: true, hint: true })} />
      </Field>,
    );
    const errored = screen.getByLabelText('Password');
    expect(errored.getAttribute('aria-describedby')).toBe(errorId('f-password'));
    expect(document.getElementById(errorId('f-password'))?.textContent).toBe('too short');
    // …and no dangling reference when the field has nothing to say.
    expect(describeBy('f-password', {})).toBeUndefined();
  });
});

describe('FormMessage', () => {
  it('announces a failure the way a failure has to be announced', () => {
    render(<FormMessage testId="login-error">wrong username or password</FormMessage>);
    const message = screen.getByRole('alert');
    expect(message.textContent).toContain('wrong username or password');
    expect(message.getAttribute('data-testid')).toBe('login-error');
  });

  it('is a status, not an alarm, when it is only information', () => {
    render(
      <FormMessage tone="info" testId="login-boot-failed">
        The API is not answering.
      </FormMessage>,
    );
    expect(screen.getByRole('status').textContent).toContain('The API is not answering.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Dialog', () => {
  /** The shape PR-12/15/16 will actually write: a trigger, a titled panel, an action row. */
  function Deletion({ verb }: { readonly verb: string }) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button>{verb}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete this note?</DialogTitle>
          <p>It cannot be undone.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Keep it</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  it('opens from its trigger, names itself, and takes the focus', async () => {
    const user = userEvent.setup();
    render(<Deletion verb="Destroy" />);

    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Destroy' }));

    const dialog = await screen.findByRole('dialog');
    // The name comes from `DialogTitle`, which is why the component makes the caller supply one: an
    // unnamed dialog is announced as "dialog" and nothing else. Following the link the primitive put in
    // `aria-labelledby` is the same computation a reader does.
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy === null ? null : document.getElementById(labelledBy)?.textContent).toBe(
      'Delete this note?',
    );
    // Escape and Tab only mean what a user thinks they mean if focus is inside, which Radix arranges
    // and this test guards, because a later "custom focus" refactor would break it silently.
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // …and focus went back where it came from, so Tab does not restart at the top of the page.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Destroy' }));
  });

  it('closes on Escape, which is the only gesture a trapped user has', async () => {
    const user = userEvent.setup();
    render(<Deletion verb="Destroy" />);
    await user.click(screen.getByRole('button', { name: 'Destroy' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Menu', () => {
  it('opens as a menu and hands the choice back', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Menu modal={false}>
        <MenuTrigger asChild>
          <Button>Theme</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={onSelect}>Light</MenuItem>
          <MenuItem danger onSelect={vi.fn()}>
            Sign out
          </MenuItem>
        </MenuContent>
      </Menu>,
    );

    await user.click(screen.getByRole('button', { name: 'Theme' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(2);
    // The destructive entry has to look destructive in a token, not in a shade someone has to notice.
    expect(items[1]?.className).toContain('text-danger');

    await user.click(screen.getByRole('menuitem', { name: 'Light' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('Toast', () => {
  function Pushable() {
    const { toast } = useToast();
    return <Button onClick={() => toast({ title: 'Saved', description: 'Your note is safe' })}>Go</Button>;
  }

  it('appears from a mutation, says why, and can be dismissed', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Pushable />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Go' }));
    // `data-testid="toast-<tone>"` is the handle PR-19's e2e specs will wait on, so the assertion is
    // about the tone as well as the words: an error that arrives looking like a confirmation is a bug.
    const toastItem = await screen.findByTestId('toast-info');
    expect(toastItem?.textContent).toContain('Saved');
    expect(toastItem?.textContent).toContain('Your note is safe');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('toast-info')).toBeNull();
  });

  it('is red when it says so', async () => {
    function Errored() {
      const { toast } = useToast();
      return (
        <Button onClick={() => toast({ title: 'Could not sign in', tone: 'error' })}>Fail loudly</Button>
      );
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Errored />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Fail loudly' }));
    expect((await screen.findByTestId('toast-error')).className).toContain('border-danger');
  });

  it('refuses to be used without its provider, and says which one', () => {
    // The alternative symptom is "nothing appeared", which is the most expensive kind of bug to find.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Pushable />)).toThrow(/ToastProvider/);
    consoleError.mockRestore();
  });

  it('keeps more than one when several things went wrong', async () => {
    function Many() {
      const { toast } = useToast();
      return (
        <Button
          onClick={() => {
            toast({ title: 'First' });
            toast({ title: 'Second' });
          }}
        >
          Two
        </Button>
      );
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Many />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Two' }));
    // Two entries from a counter, not from `randomUUID()`, and this is the test that would notice a
    // collision: React would render one row where two separate failures happened.
    expect(await screen.findAllByTestId('toast-info')).toHaveLength(2);
  });
});
