-- ============================================================
-- Admins upload product files to the private "documents" bucket through our server, which
-- calls Storage with the admin's own token. This rule is what lets that upload through.
-- ============================================================

-- security definer: reads public.users.role, which the role check must see regardless of other rules
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Insert only: no overwrite (no update policy) and no delete for anyone through the API
create policy "documents bucket: admins upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.is_admin());
