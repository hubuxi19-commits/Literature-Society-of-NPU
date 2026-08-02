begin;

select plan(8);

select has_table('public', 'account_recovery_emails');
select has_table('public', 'account_action_tokens');
select has_table('public', 'auth_rate_limits');

select has_function(
  'public',
  'is_recovery_email_verified',
  array[]::text[]
);
select has_function(
  'public',
  'is_account_write_allowed',
  array[]::text[]
);
select has_function(
  'public',
  'consume_account_action_token',
  array['bytea', 'text', 'uuid', 'integer']
);

select policies_are(
  'public',
  'account_recovery_emails',
  array[]::text[],
  'recovery emails have no browser-readable policies'
);
select is(
  (select value ->> 'write_gate'
   from public.site_settings
   where key = 'account_security'),
  'off',
  'production-safe default'
);

select * from finish();

rollback;
