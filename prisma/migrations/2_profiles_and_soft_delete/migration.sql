-- ============================================================
-- Profiles: every Supabase Auth signup gets a public.users row (role 'client').
-- Admins are promoted only by SQL: update users set role = 'admin' where email = '...';
-- ============================================================

create function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- security definer runs as owner; nobody should be able to call it directly
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Accounts created before this trigger existed
insert into public.users (id, email)
select id, email from auth.users where email is not null
on conflict (id) do nothing;

-- ============================================================
-- Soft delete: archived documents stay for existing buyers, cannot be bought again
-- ============================================================

alter table documents add column archived_at timestamptz;

-- Archiving also changes what Stripe must mirror (product inactive)
create or replace function documents_mark_stripe_pending() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.archived_at is distinct from old.archived_at then
    new.stripe_sync_status  := 'pending';
    new.stripe_sync_version := old.stripe_sync_version + 1;
  end if;
  return new;
end;
$$;

grant select (archived_at) on documents to authenticated;

-- Browser sees live catalog, plus archived documents the user already owns
drop policy "documents: catalog readable" on documents;

create policy "documents: live or owned readable" on documents
  for select to authenticated using (
    archived_at is null
    or exists (
      select 1 from public.entitlements e
      where e.document_id = documents.id
        and e.user_id = (select auth.uid())
        and e.revoked_at is null
    )
  );
