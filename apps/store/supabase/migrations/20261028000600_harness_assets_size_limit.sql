-- harness-assets holds only what the Store shows: a Harness Version's icon (a 512×512 PNG, at
-- most about 2 MB) and up to five screenshots of at most 2 MB each, which the `publish` function
-- picks (supabase/functions/_shared/storage-paths.ts). A 5 MiB limit per object is the backstop
-- that keeps this public bucket from serving anything larger; `publish` refuses a larger icon
-- before uploading anything (MAX_ASSET_BYTES).
update storage.buckets
set file_size_limit = 5242880
where id = 'harness-assets';
