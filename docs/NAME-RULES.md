# Name rules

Note and folder names have exactly **one** implementation:
[`packages/contracts/src/names.ts`](../packages/contracts/src/names.ts). The server validates with it,
the SPA pre-validates with it, and the same module generates the default name, so no two surfaces can
disagree. This file is the prose version of that module; when they disagree, the module and its tests
(`names.test.ts`) win.

## The rules

| Rule                                   | Notes                                       | Folders                  | Where it is checked                                              |
| -------------------------------------- | ------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| Non-empty after one `stripMd`           | `.md` alone is empty, so it is refused      | ✅ (no strip)            | `noteNameRejection` → `'empty'`                                  |
| At most 120 characters (`NOTE_NAME_MAX`) | `FOLDER_NAME_MAX === NOTE_NAME_MAX`        | ✅                       | `'too-long'`                                                     |
| No reserved character                   | `\ / : * ? " < > \|` and any control char     | ✅                       | `NOTE_NAME_RE` → `'reserved-characters'`                       |
| No leading/trailing whitespace          | refused, never silently trimmed              | ✅                       | `'whitespace-padded'`                                            |
| Not `.` or `..`                         | not names, in either tree                    | ✅                       | `'reserved-name'`                                                |
| Stored **extension-free**               | the `.md` is display-only                    | ❌ (`.md` is a note idea) | `'nested-extension'`, `stripMd` in the service                   |

A rule failing is reported as a `NameRejection` and rendered into the error envelope as
`{ path: 'name', message: <the rule that failed> }` (`NAME_REJECTION_MESSAGES` is the single source of
that text), so the form and the API never paraphrase the rule differently.

### `NOTE_NAME_RE`

```ts
export const NOTE_NAME_RE = /[\\/:*?"<>|\p{Cc}]/u;
```

It matches a character that is **forbidden**, so `NOTE_NAME_RE.test(name) === true` means *refuse*. The
control characters come from the Unicode category `\p{Cc}` rather than a `\u0000-\u001f` range, which
also covers DEL and the C1 set — invisible junk either way. There is no `g` flag, so `test` is
stateless. Call `isValidNoteName` / `isValidFolderName` rather than this regex directly: they add the
length, padding, reserved-name, and extension rules.

## The `.md` rule, in full (plan §8, appendix A.1)

- `stripMd(name)` removes **exactly one** trailing `.md`, case-insensitive.
- Every other rule runs on the **stripped** value. So `..md` fails as `reserved-name` (it strips to
  `.`) and `foo .md` fails as `whitespace-padded` (it strips to `foo `), rather than being stored as
  something the UI cannot tell apart from `.` / `foo`.
- A name whose stripped value *still* ends in `.md` is refused (`nested-extension`). `foo.md.md`
  therefore cannot store as `foo.md` while a note called `foo` exists — which is what makes
  `uniquify` + `withMd` collision-free.
- Consequence, and the property the tests assert over a corpus: `isValidNoteName(n)` implies
  `stripMd(stripMd(n)) === stripMd(n)`, equivalently `!endsInMd(stripMd(n))`. Stated over already
  stored names, `stripMd(stored) === stored`. It is deliberately **not** `stripMd(n) === n`: `Draft.md`
  is valid and `stripMd` shortens it.
- `notes.name` stores the stripped value. **PR-23's migration check** asserts that no stored name
  ends in `.md` (plan §8); this module is why that check can hold.

## Worked examples

| Input (as sent by the client) | Stored in `notes.name` | Displayed by `withMd` | Rule applied                                       |
| ----------------------------- | ---------------------- | --------------------- | -------------------------------------------------- |
| `Draft.md`                    | `Draft`                | `Draft.md`            | **strip**: one `.md` removed, rest of the rules pass |
| `plan.mdx`                    | `plan.mdx`             | `plan.mdx.md`         | **no strip**: not the `.md` extension, so nothing to remove |
| `a/b.md`                      | —                      | —                     | **reserved character**: refused before any strip     |
| `plan` next to an existing `plan` | `plan-2`             | `plan-2.md`           | **sibling collision**: `uniquify(base, taken)`       |

Two more that only look safe:

| Input        | Stored | Displayed | Why                                     |
| ------------ | ------ | --------- | --------------------------------------- |
| `foo.md.md`  | —      | —         | would store `foo.md`, rendering as `foo` |
| `.md`        | —      | —         | strips to the empty string               |

## Collision semantics

- **Case-sensitive**, exactly like the sibling unique indexes: `plan` and `Plan` are two different
  notes, and `uniquify('Plan', {'plan'})` returns `Plan`. A case-insensitive rule here would reject
  names the database happily stores.
- `withMd` is **injective over stored names**: for two distinct stored names `a !== b`,
  `withMd(a) !== withMd(b)`. That holds *because* a stored name never ends in `.md` — otherwise `foo`
  and `foo.md` would both display as `foo.md`.
- `uniquify(name, taken)` operates on the stored, extension-free base and appends `-2`, `-3`, … :
  `plan` → `plan-2` → `plan-3`, never `plan.md-2`. It is the double-click guard's companion: the API
  answers a sibling clash with `CONFLICT` and the winner's `id` (plan §9.1), and `uniquify` is what the
  service uses when the caller supplied no name at all.
- Sibling uniqueness is enforced in Postgres by the partial unique indexes of plan §8 (`notes` and
  `folders`, per `user_id` + parent), so the rule above is a UX guarantee and the index is the real one.

## Generated names

`newFileName(msEpoch = Date.now())` is `new-file-<msepoch>.md` — the README's rule, **extension
included**, because it is what the UI prefills and displays (§8). `POST /api/notes` with no `name`
instead stores `new-file-<msepoch>` run through `uniquify`, so two creates in the same millisecond in
the same folder do not collide (plan §9.2 #16).
