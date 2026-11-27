/**
 * The demo seed (docs/plans/mvp/MVP-09.md §5.8): `pnpm db:seed`.
 *
 * ```
 * NODE_ENV=development tsx apps/server/src/scripts/seed-demo.ts
 * ```
 *
 * It writes one demo account and a small tree, so a fresh clone has something to look at the moment PR-12 renders
 * a page, and so the folder/note endpoints can be poked by hand without writing a fixture first. This is the
 * earliest point at which a seed *can* do any of it: hashing a password needs PR-07's hasher, and the note bodies
 * need PR-06's envelope — which is why the file is not in PR-04, whose fixtures are raw ciphertext blobs.
 *
 * **Idempotent by lookup, not by truncation.** Every row is created only when the same `(user, parent, name)` is
 * absent, so a second run inserts nothing and reports the same counts, and a run after somebody has been editing
 * the demo tree does not clobber their work. (`truncate`-and-reseed would be easier to write and impossible to run
 * twice against a database anyone cares about.)
 *
 * **It never builds its own DSN.** `loadDevEnvFile()` then `databaseUrl()`, exactly like the app: the one line of
 * `POSTGRES_PORT` in `.env` has to move the container and this script together, and a hand-assembled
 * `postgres://…` is how a seed ends up writing into a different database than the API reads.
 *
 * **`NODE_ENV=production` is a hard refusal**, checked before a pool is opened. This script prints a password to
 * stdout, and a `db:seed` that a copy-pasted deploy script runs against a live install is how an unauthenticated
 * `demo` account gets into somebody's notes.
 *
 * ## Exit codes
 *
 * | Code | Meaning                                                        |
 * | ---- | -------------------------------------------------------------- |
 * | 0    | the tree exists (whether this run created it or found it there)   |
 * | 2    | refused: `production`, or the env/keyring would not load          |
 */
import process from 'node:process';
import { createArgon2Hasher, type PasswordHasher } from '../auth/passwords.js';
import { sealNoteContent } from '../crypto/envelope.js';
import { buildKeyring, type Keyring } from '../crypto/keys.js';
import { createDb, type Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { createFolder, folderByParentAndName } from '../db/repositories/folders.repo.js';
import { createNote, noteByFolderAndName } from '../db/repositories/notes.repo.js';
import { createUserWithSettings, userByUsername } from '../db/repositories/users.repo.js';
import type { Folder } from '../db/schema.js';
import { ConflictError } from '../domain/errors.js';
import { databaseUrl, EnvError, loadDevEnvFile, nodeEnvOf, parseEnv } from '../env.js';
import { createLogger } from '../logger.js';

/** The account the seed owns. Nothing else in this repo uses it, and PR-12's docs name it. */
export const DEMO_USERNAME = 'demo';

/**
 * The demo password, printed on creation.
 *
 * It is a *development* credential and is written here in plain text on purpose: the guard below is what keeps it
 * out of a production install, and an operator who has to invent a password to run a demo seed will invent `demo`.
 */
export const DEMO_PASSWORD = 'note-taker-demo';

const USAGE = `seed-demo — write the demo user and a sample tree (development/test only)

  -h, --help   this text

Refuses in production. Reads the same env the app does (DATABASE_URL or POSTGRES_*), through
loadDevEnvFile() + databaseUrl(); generates a note key in development exactly as the app does.`;

/** One note body, extension-free name included. */
interface NoteSpec {
  readonly name: string;
  readonly content: string;
}

/** A folder and everything under it, so the tree below is the data and not a pile of inserts. */
interface FolderSpec {
  readonly name: string;
  readonly notes?: readonly NoteSpec[];
  readonly children?: readonly FolderSpec[];
}

/**
 * The sample tree: three levels deep in one branch (the depth a UI has to scroll), a note at every level
 * including the root, and one body with a code fence and non-ASCII text so `content_bytes` is visibly *bytes*
 * rather than `.length` (plan §10's UTF-8 rule).
 */
export const DEMO_TREE: readonly FolderSpec[] = [
  {
    name: 'projects',
    notes: [{ name: 'roadmap', content: '# Roadmap\n\n- ship the MVP\n- write the runbook\n' }],
    children: [
      {
        name: '2026',
        notes: [
          {
            name: 'q4-goals',
            content: '# Q4 goals\n\n1. encryption at rest, verified\n2. offline-first editor\n',
          },
        ],
        children: [
          {
            name: 'archive',
            notes: [
              {
                name: 'meeting-notes',
                content:
                  '# Meeting notes — 2026-01-14\n\nAttendees: Émile, 佐藤, 🖥️\n\n```ts\nconst note = await api.createNote({ content });\n```\n\nNothing here is real; it is here to prove the bytes.\n',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'reading',
    notes: [
      { name: 'books', content: '# Books\n\n- The Design of Everyday Things\n- Thinking, Fast and Slow\n' },
    ],
  },
];

/** The two notes that live at the root, i.e. `folder_id is null`. */
export const DEMO_ROOT_NOTES: readonly NoteSpec[] = [
  {
    name: 'welcome',
    content:
      '# Welcome to Note Taker\n\nThis note was written by `pnpm db:seed`. Its body is encrypted at rest with AES-256-GCM and never leaves the server unsealed except to you.\n\n- `GET /api/tree` lists this note **without** its body\n- `GET /api/notes/:id` decrypts it\n- the folder above is three levels deep, and the tree caps at 100\n',
  },
  { name: 'scratch', content: '' },
];

/**
 * What one run did. Returned rather than logged, so the integration test can assert the counts, and mutable
 * because it is an accumulator: {@link seedFolder} walks the tree and adds to it.
 */
export interface SeedSummary {
  /** `created` only when this run inserted the account; a re-run always says `existing`. */
  user: 'created' | 'existing';
  foldersCreated: number;
  notesCreated: number;
  foldersKept: number;
  notesKept: number;
}

/**
 * The production guard, split out so it is testable without a database.
 *
 * `NODE_ENV` is what it checks — never a `SEED_ALLOWED` flag: the brief's rule is "the mode this process was
 * started in", and a second variable would be a way to bypass the first.
 */
export function seedRefusal(nodeEnv: string | undefined): string | undefined {
  return nodeEnv === 'production'
    ? 'refusing to seed a production database: this script writes a demo account with a known password'
    : undefined;
}

/**
 * Writes the demo user and tree, creating only what is missing.
 *
 * `passwords` and `keyring` are injected rather than built here because the hasher costs ~100 ms per hash and a
 * test wants its own; the keyring is injected because sealing an empty body still needs a real key, and a seed
 * that silently generated a second one would make every note it ever wrote unreadable to the app.
 */
export async function seedDemo(
  db: Db,
  deps: { readonly passwords: PasswordHasher; readonly keyring: Keyring },
): Promise<SeedSummary> {
  const summary: SeedSummary = {
    user: 'existing',
    foldersCreated: 0,
    notesCreated: 0,
    foldersKept: 0,
    notesKept: 0,
  };

  const existing = await userByUsername(db, DEMO_USERNAME);
  let userId: string;
  if (existing === undefined) {
    try {
      const created = await createUserWithSettings(db, {
        username: DEMO_USERNAME,
        passwordHash: await deps.passwords.hash(DEMO_PASSWORD),
        // `member`, never `owner`: `users_one_owner_uidx` allows exactly one owner and `/api/auth/setup` claims
        // it. A seed that took the owner slot would make the first-run wizard impossible to complete.
        role: 'member',
        displayName: 'Demo',
      });
      userId = created.id;
      summary.user = 'created';
    } catch (error) {
      // Two seeds at once is the only way here, and losing that race means the other one already made the account.
      if (!(error instanceof ConflictError)) throw error;
      const raced = await userByUsername(db, DEMO_USERNAME);
      if (raced === undefined) throw error;
      userId = raced.id;
    }
  } else {
    userId = existing.id;
  }

  for (const note of DEMO_ROOT_NOTES) {
    if (await ensureNote(db, { userId, folderId: null, note, keyring: deps.keyring }))
      summary.notesCreated += 1;
    else summary.notesKept += 1;
  }

  for (const folder of DEMO_TREE) {
    await seedFolder(db, { userId, folder, keyring: deps.keyring, summary });
  }

  return summary;
}

/** Inserts one folder if its name is free under `parentId`, then walks what it contains. */
async function seedFolder(
  db: Db,
  input: {
    readonly userId: string;
    readonly folder: FolderSpec;
    readonly keyring: Keyring;
    readonly summary: SeedSummary;
    readonly parentId?: string | null;
  },
): Promise<void> {
  const parentId = input.parentId ?? null;
  const existing = await folderByParentAndName(db, {
    userId: input.userId,
    parentId,
    name: input.folder.name,
  });

  let folder: Folder;
  if (existing === undefined) {
    folder = await createFolder(db, { userId: input.userId, parentId, name: input.folder.name });
    input.summary.foldersCreated += 1;
  } else {
    folder = existing;
    input.summary.foldersKept += 1;
  }

  for (const note of input.folder.notes ?? []) {
    if (await ensureNote(db, { userId: input.userId, folderId: folder.id, note, keyring: input.keyring })) {
      input.summary.notesCreated += 1;
    } else {
      input.summary.notesKept += 1;
    }
  }

  for (const child of input.folder.children ?? []) {
    await seedFolder(db, { ...input, folder: child, parentId: folder.id });
  }
}

/** @returns `true` when this call inserted the note, `false` when the same name was already there. */
async function ensureNote(
  db: Db,
  input: {
    readonly userId: string;
    readonly folderId: string | null;
    readonly note: NoteSpec;
    readonly keyring: Keyring;
  },
): Promise<boolean> {
  const existing = await noteByFolderAndName(db, {
    userId: input.userId,
    folderId: input.folderId,
    name: input.note.name,
  });
  if (existing !== undefined) return false;

  // The id first, then the seal: the envelope's AAD is `note:<uuid>`, so there is no order in which the body
  // could be sealed against an id this insert had not chosen yet (MVP-06 §5).
  const id = newId();
  await createNote(db, {
    id,
    userId: input.userId,
    folderId: input.folderId,
    name: input.note.name,
    content: sealNoteContent(input.note.content, id, input.keyring),
  });
  return true;
}

/** Prints one line per fact the operator needs, and nothing else. */
function report(summary: SeedSummary, write: (line: string) => void): void {
  write(
    summary.user === 'created'
      ? `created ${DEMO_USERNAME} / ${DEMO_PASSWORD} (member; sign in at POST /api/auth/login)`
      : `kept the existing ${DEMO_USERNAME} account (password unchanged)`,
  );
  write(
    `folders: ${summary.foldersCreated} created, ${summary.foldersKept} already there; ` +
      `notes: ${summary.notesCreated} created, ${summary.notesKept} already there`,
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  loadDevEnvFile();
  const nodeEnv = nodeEnvOf(process.env);
  const refusal = seedRefusal(nodeEnv);
  if (refusal !== undefined) {
    process.stderr.write(`seed-demo: ${refusal}\n`);
    return 2;
  }

  const env = parseEnv();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV).child({ script: 'seed-demo' });

  let keyring: Keyring;
  try {
    // The same ring the API would build, including the development-only generated file under `.dev/`: a seed
    // that used a different key would write rows nothing can read back.
    keyring = buildKeyring({ logger });
  } catch (error) {
    if (error instanceof EnvError) {
      for (const problem of error.problems) logger.error({ problem }, 'keyring refused to build');
      return 2;
    }
    throw error;
  }

  const handle = createDb({ url: databaseUrl(), max: 1 });
  try {
    const summary = await seedDemo(handle.db, { passwords: createArgon2Hasher(), keyring });
    report(summary, (line) => logger.info(line));
    return 0;
  } finally {
    await handle.close();
  }
}

/**
 * The self-run guard, same shape as `rotate-note-key.ts`: the integration suite *imports* this module to call
 * {@link seedDemo} twice against its own pool, so the entry point may not run on import — and `import.meta.main`
 * is newer than the Node this repo pins.
 */
const invokedDirectly = process.argv[1] !== undefined && /seed-demo\.[cm]?[jt]s$/u.test(process.argv[1]);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`seed-demo failed: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
