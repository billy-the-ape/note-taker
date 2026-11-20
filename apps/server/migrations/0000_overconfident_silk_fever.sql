-- PR-04 (docs/plans/mvp/MVP-04.md §8). The one statement below that drizzle-kit did not write: drizzle-orm
-- 0.45 cannot declare a public-schema extension in `src/db/schema.ts`, so §8's `CREATE EXTENSION IF NOT EXISTS
-- pgcrypto` is added here once, by hand, and `src/db/schema.int.test.ts` asserts that it lands. Nothing in the
-- MVP reads it — ids come from `newId()` in the application, not `gen_random_uuid()` — but the contract in §8
-- and docs/DATA-MODEL.md says the database has it, so it must actually have it.
--
-- Everything after this comment block is `pnpm db:generate`'s output. Do not hand-edit it: drizzle-kit stores
-- the hash of each applied file in `drizzle.__drizzle_migrations`, so a post-apply rewrite fails every later
-- `db:migrate`.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE "auth_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_key" text NOT NULL,
	"succeeded" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_name_check" CHECK ("folders"."name" <> '')
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_cipher" "bytea" NOT NULL,
	"content_iv" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"content_format" text DEFAULT 'markdown' NOT NULL,
	"content_bytes" integer DEFAULT 0 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"content_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_name_check" CHECK ("notes"."name" <> '')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"autosave" boolean DEFAULT true NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_theme_check" CHECK ("settings"."theme" in ('system', 'light', 'dark'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"password_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('owner', 'member'))
);
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_attempts_key_at_idx" ON "auth_attempts" USING btree ("user_key","at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "folders_unique_sib" ON "folders" USING btree ("user_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"name");--> statement-breakpoint
CREATE INDEX "folders_user_parent_idx" ON "folders" USING btree ("user_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_unique_sib" ON "notes" USING btree ("user_id",coalesce("folder_id", '00000000-0000-0000-0000-000000000000'::uuid),"name");--> statement-breakpoint
CREATE INDEX "notes_user_folder_idx" ON "notes" USING btree ("user_id","folder_id");--> statement-breakpoint
CREATE INDEX "notes_user_content_updated_idx" ON "notes" USING btree ("user_id","content_updated_at" desc);--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_uidx" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_owner_uidx" ON "users" USING btree ("role") WHERE "users"."role" = 'owner';