#!/usr/bin/env node
/**
 * Migration: `users` + `gusers`  ->  `users` (unified User model).
 *
 * The earlier schema stored one concept in two collections:
 *   users  { fullName, email, password, profilePicture, role }   email+password
 *   gusers { fullName, email, profilePicture, role }             Google
 *
 * docs/02_TRD.md §9 collapses these into one document with an authProviders
 * array. See models/User.js.
 *
 *   node scripts/migrate-users.js                 # DRY RUN: reports, writes nothing
 *   node scripts/migrate-users.js --apply         # performs the migration
 *   node scripts/migrate-users.js --apply --uri mongodb://.../scratch
 *
 * Dry run is the default deliberately. Run it against a scratch copy first and
 * read the report before letting it touch anything real.
 *
 * Notes on fidelity:
 *  - Password hashes are COPIED, not recomputed. The plaintext is unavailable,
 *    and bcrypt hashes are self-describing, so an old cost-10 hash keeps
 *    verifying correctly; new passwords are hashed at the current cost.
 *  - `gusers` never stored the Google account id, so providerId is seeded with
 *    the email as a placeholder. User#linkProvider upgrades it to the real id on
 *    the next Google sign-in.
 *  - An email present in BOTH collections becomes ONE user with TWO providers.
 */
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/lib/db.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const uriFlag = argv.indexOf('--uri');
const OVERRIDE_URI = uriFlag !== -1 ? argv[uriFlag + 1] : null;

function line(s = '') { process.stdout.write(`${s}\n`); }

/** Reads the two legacy collections directly: their models no longer exist. */
async function readLegacy(db) {
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const local = names.includes('users') ? await db.collection('users').find({}).toArray() : [];
  const google = names.includes('gusers') ? await db.collection('gusers').find({}).toArray() : [];
  return { local, google, names };
}

/** Builds the merged set, keyed by lowercased email. */
export function planMigration({ local, google }) {
  const byEmail = new Map();
  const problems = [];

  const upsert = (doc, provider) => {
    const email = String(doc.email ?? '').trim().toLowerCase();
    if (!email) {
      problems.push(`${provider} record ${doc._id} has no email: skipped`);
      return;
    }
    const entry = byEmail.get(email) ?? {
      email,
      displayName: '',
      passwordHash: undefined,
      avatarUrl: '',
      role: 'user',
      authProviders: [],
      sources: [],
      createdAt: doc.createdAt,
    };

    entry.displayName ||= doc.fullName || email.split('@')[0];
    entry.avatarUrl ||= doc.profilePicture || '';
    if (doc.role === 'admin') entry.role = 'admin';
    if (provider === 'local' && doc.password) entry.passwordHash = doc.password;
    if (doc.createdAt && (!entry.createdAt || doc.createdAt < entry.createdAt)) {
      entry.createdAt = doc.createdAt;
    }

    if (!entry.authProviders.some((p) => p.provider === provider)) {
      entry.authProviders.push({
        provider,
        // gusers stored no Google id; email is a placeholder that
        // User#linkProvider upgrades on the next real sign-in.
        providerId: provider === 'local' ? email : String(doc.googleId ?? email),
        email,
      });
    }
    entry.sources.push(`${provider}:${doc._id}`);
    byEmail.set(email, entry);
  };

  for (const doc of local) upsert(doc, 'local');
  for (const doc of google) upsert(doc, 'google');

  return { users: [...byEmail.values()], problems };
}

/**
 * Applies the plan.
 *
 * The unified model lives in the SAME collection as the legacy email/password
 * accounts ('users': see models/User.js), so this is an in-place upgrade, not
 * an insert: legacy fields are rewritten and unset on the existing document,
 * which preserves _id and therefore every TestRun that references it.
 *
 * Idempotent: a document already carrying authProviders is left alone, so the
 * script can be re-run safely.
 */
export async function applyMigration(db, users) {
  const col = db.collection('users');
  let upgraded = 0;
  let inserted = 0;
  let untouched = 0;

  for (const u of users) {
    const existing = await col.findOne({ email: new RegExp(`^${escapeRegex(u.email)}$`, 'i') });

    if (existing?.authProviders?.length) { untouched += 1; continue; }

    const doc = {
      email: u.email,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      role: u.role,
      authProviders: u.authProviders,
      updatedAt: new Date(),
    };
    if (u.passwordHash) doc.passwordHash = u.passwordHash;

    if (existing) {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: doc,
          // Drop the legacy field names now that their values have been copied.
          $unset: { fullName: '', password: '', profilePicture: '' },
        },
      );
      upgraded += 1;
    } else {
      await col.insertOne({ ...doc, createdAt: u.createdAt ?? new Date() });
      inserted += 1;
    }
  }

  return { upgraded, inserted, untouched };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const env = loadEnv();
  const uri = OVERRIDE_URI || env.MONGO_URI;

  line();
  line('AGENTIQ: user migration  (users + gusers -> unified User)');
  line(`  mode:   ${APPLY ? 'APPLY (will write)' : 'DRY RUN (writes nothing)'}`);
  line(`  target: ${uri.replace(/\/\/[^@]*@/, '//****:****@')}`);
  line();

  await connectDB(uri);
  const db = mongoose.connection.db;

  const legacy = await readLegacy(db);
  line(`  collections present: ${legacy.names.join(', ') || '(none)'}`);
  line(`  legacy 'users'  : ${legacy.local.length}`);
  line(`  legacy 'gusers' : ${legacy.google.length}`);

  if (legacy.local.length === 0 && legacy.google.length === 0) {
    line('\n  Nothing to migrate.\n');
    await disconnectDB();
    return;
  }

  const { users, problems } = planMigration(legacy);
  const dual = users.filter((u) => u.authProviders.length > 1);

  line();
  line(`  merged into    : ${users.length} user document(s)`);
  line(`  dual-provider  : ${dual.length}  (existed in both collections)`);
  line(`  with password  : ${users.filter((u) => u.passwordHash).length}`);
  if (problems.length) {
    line('\n  Problems:');
    for (const p of problems) line(`    - ${p}`);
  }

  if (!APPLY) {
    line('\n  Preview (first 10):');
    for (const u of users.slice(0, 10)) {
      line(`    ${u.email.padEnd(32)} ${u.authProviders.map((p) => p.provider).join('+')}`);
    }
    line('\n  DRY RUN, nothing was written. Re-run with --apply to migrate.\n');
    await disconnectDB();
    return;
  }

  const { upgraded, inserted, untouched } = await applyMigration(db, users);

  line();
  line(`  upgraded: ${upgraded}  (legacy 'users' documents rewritten in place)`);
  line(`  inserted: ${inserted}  (existed only in 'gusers')`);
  line(`  untouched: ${untouched}  (already in the new shape: re-run is safe)`);
  line();
  line("  The 'gusers' collection was NOT dropped. Verify sign-in works for a");
  line('  migrated Google account, then drop it manually. Nothing is deleted by');
  line('  this script.');
  line();

  await disconnectDB();
}

// Only run when invoked directly, so tests can import planMigration().
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((err) => {
    process.stderr.write(`\n  Migration failed: ${err.message}\n\n`);
    process.exit(1);
  });
}
