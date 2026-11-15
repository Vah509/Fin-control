create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth; create schema extensions; create schema vault;
create table auth.users(id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create view vault.decrypted_secrets as select 'identifier_enc_key'::text as name, 'k'::text as decrypted_secret;
grant usage on schema auth, extensions, public to anon, authenticated, service_role;
grant select on auth.users to authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant select on vault.decrypted_secrets to authenticated; grant usage on schema vault to authenticated;
