-- ============================================================
-- full_name is required. Signup passes it as Supabase user metadata (options.data.full_name);
-- the auth trigger copies it in the same insert, so a user row never exists without a name.
-- ============================================================

-- Rows created before this rule: use the email's local part so NOT NULL can be applied
update public.users
set full_name = split_part(email, '@', 1)
where full_name is null or btrim(full_name) = '';

alter table public.users
  alter column full_name set not null,
  add constraint users_full_name_length check (char_length(btrim(full_name)) between 1 and 200);

-- Also guards direct Supabase signups (public API, publishable key) that skip our server's validation:
-- raising here aborts the auth.users insert, so the account is not created at all
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  name text := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
begin
  if name = '' then
    raise exception 'full_name is required' using errcode = 'check_violation';
  end if;

  insert into public.users (id, email, full_name)
  values (new.id, new.email, name)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;
