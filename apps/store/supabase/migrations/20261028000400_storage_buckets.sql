-- The two Storage buckets. Paths are relative to the bucket:
--   harness-packages  <publisher>/<slug>/<version>.zip
--   harness-assets    <publisher>/<slug>/<version>/icon.png
--                     <publisher>/<slug>/<version>/screenshots/<n>.<ext>
--
-- No policy on storage.objects mentions either bucket, and Storage keeps row-level security on
-- that table, so anon and authenticated can neither list, read (other than below) nor write.
-- harness-packages is private: packages leave only through the `download` function's short-lived
-- signed URLs. harness-assets is public, which serves its objects by URL
-- (/storage/v1/object/public/harness-assets/<path>) without making them listable.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('harness-packages', 'harness-packages', false, 524288000, array['application/zip']),
  ('harness-assets', 'harness-assets', true, null, array['image/png', 'image/jpeg'])
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
