/**
 * How big the note on screen is, and when that size becomes worth saying out loud
 * (docs/plans/mvp/MVP-13.md §5 "Guards & counters").
 *
 * Two numbers and one decision, all three of them pure:
 *
 * * **bytes** — the one the server rules on. `utf8ByteLength` is `@note-taker/contracts`' own function,
 *   so the count on screen is the count `POST`/`PUT` will compute before it seals the body; a client
 *   that counted characters would tell a person their 1.1 MiB note was fine.
 * * **characters** — the one a person reading a prose buffer has in their head. Both are shown, because
 *   they are different questions and the app has no authority to pick one.
 * * **the threshold** — the server's cap is `NOTE_CONTENT_MAX_BYTES` (1 MiB, the same constant the
 *   transport rejects a body with) and the UI warns from `NOTE_CONTENT_WARN_BYTES` (900 KiB) onwards.
 *   Both come from the contract, so a cap change moves the warning in the same commit rather than in two
 *   places that each got the memo.
 *
 * The status function exists so §6's "unit-test the threshold logic; do not build a 900 KiB DOM fixture"
 * can be honoured: the boundary is four numbers in a test, and the component under test is handed a
 * status rather than asked to derive one from a string it would have to be fed a megabyte of.
 */
import { NOTE_CONTENT_MAX_BYTES, NOTE_CONTENT_WARN_BYTES, utf8ByteLength } from '@note-taker/contracts';

/** What the byte counter shows. */
export interface NoteSize {
  /** UTF-8 bytes, i.e. the number the server's cap is measured against. */
  readonly bytes: number;
  /** UTF-16 code units — "characters" in the sense a text field means it. */
  readonly chars: number;
  readonly status: SizeStatus;
}

/** `'over'` is a separate state from `'warn'` because the sentence changes: one is "getting big", the other is "the save will be refused". */
export type SizeStatus = 'ok' | 'warn' | 'over';

/**
 * Where a buffer of `bytes` stands against the server's cap.
 *
 * The warning is inclusive of the threshold (900 KiB exactly is the first byte that warns — the point of
 * a threshold is that it is reached, not that it is passed), and the cap is inclusive of the cap for the
 * same reason: a body of exactly 1 MiB is accepted by `contentUpdateSchema`, so `over` starts one byte
 * later.
 */
export function sizeStatus(bytes: number): SizeStatus {
  if (bytes > NOTE_CONTENT_MAX_BYTES) return 'over';
  if (bytes >= NOTE_CONTENT_WARN_BYTES) return 'warn';
  return 'ok';
}

/** The two numbers, plus the status the counter paints them in. */
export function noteSize(content: string): NoteSize {
  const bytes = utf8ByteLength(content);
  return { bytes, chars: content.length, status: sizeStatus(bytes) };
}

/**
 * `12.3 KiB of 1 MiB` — the number a person can compare with the cap without knowing what 921600 means.
 *
 * Below a KiB the raw byte count is more useful than `0.02 KiB`, and above one the round number is the
 * only form that survives a glance. `MiB`/`KiB` rather than `MB`/`KB` because the caps are binary
 * (1024), and the difference is exactly the size of the note that fits on one side of it.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 2 : 1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/** The counter's whole line: `4.2 KiB · 1 024 characters`, and the warning when there is one. */
export function counterText(size: NoteSize): string {
  const bytes = `${formatBytes(size.bytes)} of ${formatBytes(NOTE_CONTENT_MAX_BYTES)}`;
  const characters = `${size.chars.toLocaleString('en-US')} characters`;
  return `${bytes} · ${characters}`;
}

/**
 * The warning sentence, or `undefined` when there is nothing to warn about.
 *
 * `over` says what the server will do, because at that point the useful fact is not the size but the
 * consequence — and PR-14's pill will say `Not saved — that note is too large to save` seconds later, so
 * the two lines have to agree about which one of them is the bad news.
 */
export function sizeWarning(status: SizeStatus): string | undefined {
  switch (status) {
    case 'ok':
      return undefined;
    case 'warn':
      return `This note is over ${formatBytes(NOTE_CONTENT_WARN_BYTES)}, and the server refuses anything past ${formatBytes(NOTE_CONTENT_MAX_BYTES)}.`;
    case 'over':
      return `This note is past the ${formatBytes(NOTE_CONTENT_MAX_BYTES)} cap, so the server will refuse to save it.`;
  }
}
