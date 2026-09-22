-- Adds account correlation to the anonymous device-visit counter
-- (patch16, device_visits). Direct instruction: "the device visit table
-- needs to be able to correlate to users with an account. right now I
-- can't tell who is who if they sign-in."
--
-- Purely additive -- one nullable column, no backfill (pre-existing rows'
-- sign-in history was never captured and can't be reconstructed). Written
-- by server.js's own /device-ping route, never sent by the client: it
-- reads req.userEmail, which the global auth middleware every other route
-- already goes through sets whenever the ping carries a real Supabase
-- session token. So a signed-in user's device correlates to their account
-- using auth data that was already reaching this route -- nothing new is
-- collected client-side to make this work, and the "no phishing, no
-- fingerprinting, nothing requested from the user" constraint device_visits
-- shipped under (see patch16) still holds: this is the account they
-- explicitly signed into, not anything inferred or asked for.
--
-- An anonymous ping (tier-secret auth, no session) never has req.userEmail
-- set, and the write omits the column entirely on that path (undefined ->
-- dropped from the upsert payload) -- so a device's last known real account
-- stays attached even through later anonymous pings, rather than getting
-- cleared every time the app opens without a live session.
alter table public.device_visits add column if not exists user_email text;

comment on column public.device_visits.user_email is
  'The signed-in account (if any) last seen pinging from this device. Null for a device that has only ever pinged anonymously. Set only when a real Supabase-authenticated session sent the ping -- never inferred, never overwritten with null by a later anonymous ping from the same device.';

-- No RLS/grants change needed -- device_visits already has RLS disabled
-- and anon/authenticated revoked (patch16); adding a nullable column to an
-- already-locked-down table doesn't reopen that. Still worth a quick
-- confirm after running this, per the standing rule in CLAUDE.md:
--
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'device_visits'
--     and grantee in ('anon','authenticated');
--
-- Zero rows is the only thing that actually confirms it.
