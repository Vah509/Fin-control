\set ON_ERROR_STOP off
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000a1','owner@x'),('00000000-0000-0000-0000-0000000000b2','other@x');
insert into public.countries(key,name,timezone) values ('ua','Украина','Europe/Kyiv');
insert into public.currencies(key,code,decimals) values ('uah','UAH',2);
insert into public.projects(id,key,name) values ('00000000-0000-0000-0000-0000000000c1','p','P');
insert into public.accounts(id,key,name,type,project_id,currency_key,country_key,tracking_mode)
 values ('00000000-0000-0000-0000-0000000000d1','a','A','bank','00000000-0000-0000-0000-0000000000c1','uah','ua','balance_and_movements');
insert into public.account_access(account_id,user_id,role) values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1','owner');
set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-0000000000a1';
\echo -- 1 владелец: запись пакета с import_jobs
select public.apply_batch('{"put":{"import_jobs":[{"id":"00000000-0000-0000-0000-0000000000e1","status":"waiting_file","accounts":[{"accountId":"x","balanceMinor":70126,"asOf":"2026-11-15T10:00:00.000Z"}],"package_text":"# x","contract_version":1,"created_by":null,"created_at":"2026-11-15T10:00:00.000Z","updated_at":"2026-11-15T10:00:00.000Z"}],"app_settings":[{"key":"base_currency","value":"eur"}]},"audit":[{"at":"2026-11-15T10:00:00Z","user_id":"00000000-0000-0000-0000-0000000000a1","action":"import_job_created","table_name":"import_jobs","record_id":"e1"}]}'::jsonb);
select status, contract_version, accounts->0->>'balanceMinor' as bal from public.import_jobs;
\echo -- 2 владелец: обновление статуса (upsert)
select public.apply_batch('{"put":{"import_jobs":[{"id":"00000000-0000-0000-0000-0000000000e1","status":"cancelled","accounts":[],"package_text":"# x","contract_version":1,"created_by":null,"created_at":"2026-11-15T10:00:00.000Z","updated_at":"2026-11-15T11:00:00.000Z"}]}}'::jsonb);
select status from public.import_jobs;
\echo -- 3 плохой статус отклоняется
select public.apply_batch('{"put":{"import_jobs":[{"id":"00000000-0000-0000-0000-0000000000e2","status":"bogus","accounts":[],"package_text":"","contract_version":1}]}}'::jsonb);
\echo -- 4 не владелец: не видит и не пишет
set request.jwt.claim.sub='00000000-0000-0000-0000-0000000000b2';
select count(*) as visible from public.import_jobs;
select public.apply_batch('{"put":{"import_jobs":[{"id":"00000000-0000-0000-0000-0000000000e3","status":"waiting_file","accounts":[],"package_text":"","contract_version":1}]}}'::jsonb);
\echo -- 5 anon: нет доступа
reset role; set role anon;
select count(*) from public.import_jobs;
