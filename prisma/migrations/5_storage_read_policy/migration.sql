-- ============================================================
-- Private bucket "documents": a signed-in user may read a file only if they hold an active
-- entitlement for the document stored at that path. Signed URLs are created with the user's
-- own token, so Storage enforces this even if a server check were wrong.
-- ============================================================

-- security definer: the check needs documents.storage_path, a column the browser role cannot read
create function public.can_read_document_file(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.documents d
    join public.entitlements e on e.document_id = d.id
    where d.storage_path = object_name
      and e.user_id = (select auth.uid())
      and e.revoked_at is null
  );
$$;

revoke execute on function public.can_read_document_file(text) from public, anon;
grant execute on function public.can_read_document_file(text) to authenticated;

create policy "documents bucket: entitled users read"
  on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.can_read_document_file(name));
