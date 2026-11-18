-- AA→SA wave 2, batch B: rename the persistence objects from the historical
-- aa_ spellings to the sa_ spellings (tables, indexes, policies, triggers and
-- the aa_ RPC functions).
--
-- Append-only: every historical migration above still creates the aa_ objects;
-- this file renames them in place so a fresh filename-order replay converges on
-- the sa_ end state. ALTER ... RENAME preserves owners, grants and revokes.
--
-- plpgsql resolves table and function references at execution time, so the
-- surviving aa_-era function bodies are additionally re-issued below with the
-- sa_ spellings; without that, every draft RPC would fail at runtime after the
-- renames. Bodies that reference no aa_ object (the trigger touch helpers,
-- serialize_sa_transaction_draft, resolve_sa_draft_access_scope and
-- assert_sa_draft_activity_allowed) need no replacement. CREATE OR REPLACE
-- keeps owners and grants, and no signature changes.

-- =============================================================================
-- Tables (aa_accounts is not part of this chain — it lives in the Neon market
-- deploy database, not in Supabase — so there is no aa_accounts rename here).
-- =============================================================================
alter table public.aa_transaction_drafts rename to sa_transaction_drafts;
alter table public.aa_account_metadata rename to sa_account_metadata;

-- =============================================================================
-- Functions (all aa_ functions in public → sa_; grants carry over with the OIDs)
-- =============================================================================
alter function public.touch_aa_transaction_drafts_updated_at() rename to touch_sa_transaction_drafts_updated_at;
alter function public.create_aa_draft(jsonb) rename to create_sa_draft;
alter function public.get_aa_draft_by_share_slug(text, text) rename to get_sa_draft_by_share_slug;
alter function public.serialize_aa_transaction_draft(public.sa_transaction_drafts, text, text) rename to serialize_sa_transaction_draft;
alter function public.require_aa_draft_collaboration_access(text, text) rename to require_sa_draft_collaboration_access;
alter function public.require_aa_draft_operator_access(text, text) rename to require_sa_draft_operator_access;
alter function public.resolve_aa_draft_access_scope(public.sa_transaction_drafts, text) rename to resolve_sa_draft_access_scope;
alter function public.append_aa_draft_signature(text, text, jsonb) rename to append_sa_draft_signature;
alter function public.set_aa_draft_status(text, text, text) rename to set_sa_draft_status;
alter function public.patch_aa_draft_metadata(text, jsonb) rename to patch_sa_draft_metadata;
alter function public.append_aa_draft_activity(text, text, jsonb) rename to append_sa_draft_activity;
alter function public.set_aa_draft_relay_preflight(text, text, jsonb) rename to set_sa_draft_relay_preflight;
alter function public.append_aa_draft_submission_receipt(text, text, jsonb) rename to append_sa_draft_submission_receipt;
alter function public.rotate_aa_draft_collaboration_slug(text, text) rename to rotate_sa_draft_collaboration_slug;
alter function public.rotate_aa_draft_operator_slug(text, text) rename to rotate_sa_draft_operator_slug;
alter function public.assert_aa_draft_activity_allowed(text, jsonb) rename to assert_sa_draft_activity_allowed;
alter function public.touch_aa_account_metadata_updated_at() rename to touch_sa_account_metadata_updated_at;

-- =============================================================================
-- Triggers
-- =============================================================================
alter trigger aa_transaction_drafts_updated_at on public.sa_transaction_drafts rename to sa_transaction_drafts_updated_at;
alter trigger trg_aa_account_metadata_updated_at on public.sa_account_metadata rename to trg_sa_account_metadata_updated_at;

-- =============================================================================
-- Indexes
-- =============================================================================
alter index public.aa_transaction_drafts_share_slug_idx rename to sa_transaction_drafts_share_slug_idx;
alter index public.aa_transaction_drafts_collaboration_slug_idx rename to sa_transaction_drafts_collaboration_slug_idx;
alter index public.aa_transaction_drafts_operator_slug_idx rename to sa_transaction_drafts_operator_slug_idx;
alter index public.idx_aa_drafts_status rename to idx_sa_drafts_status;
alter index public.idx_aa_drafts_created_at rename to idx_sa_drafts_created_at;
alter index public.idx_aa_drafts_operator_slug rename to idx_sa_drafts_operator_slug;
alter index public.idx_aa_drafts_collaboration_slug rename to idx_sa_drafts_collaboration_slug;

-- =============================================================================
-- Policies (PostgreSQL has no ALTER POLICY ... RENAME; drop and recreate the
-- sole surviving policy with its sa_ name — the 20260327 hardening migration
-- already dropped the permissive insert/update policies).
-- =============================================================================
drop policy if exists "Public read aa_account_metadata" on public.sa_account_metadata;
create policy "Public read sa_account_metadata"
  on public.sa_account_metadata for select
  using (true);

-- =============================================================================
-- Function bodies (final chain definitions, re-issued with sa_ references)
-- =============================================================================
-- The four draft mutators keep their FOR UPDATE locks (20260327 FIX 3,
-- 20260611 FIX 1) and create_sa_draft keeps its payload bounds (20260611 FIX 2).
-- =============================================================================

create or replace function public.create_sa_draft(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
  next_draft_id uuid;
  next_share_slug text;
  next_collaboration_slug text;
  next_operator_slug text;
  next_signer_requirements jsonb;
  next_signatures jsonb;
  next_metadata jsonb;
begin
  if pg_column_size(p_payload) > 65536 then
    raise exception 'draft_payload_too_large';
  end if;

  next_signer_requirements := coalesce(p_payload -> 'signer_requirements', '[]'::jsonb);
  if jsonb_typeof(next_signer_requirements) = 'null' then
    next_signer_requirements := '[]'::jsonb;
  end if;
  if jsonb_typeof(next_signer_requirements) <> 'array' or jsonb_array_length(next_signer_requirements) > 100 then
    raise exception 'draft_signer_requirements_invalid';
  end if;

  next_signatures := coalesce(p_payload -> 'signatures', '[]'::jsonb);
  if jsonb_typeof(next_signatures) = 'null' then
    next_signatures := '[]'::jsonb;
  end if;
  if jsonb_typeof(next_signatures) <> 'array' or jsonb_array_length(next_signatures) > 100 then
    raise exception 'draft_signatures_invalid';
  end if;

  next_metadata := coalesce(p_payload -> 'metadata', '{}'::jsonb);
  if jsonb_typeof(next_metadata) = 'null' then
    next_metadata := '{}'::jsonb;
  end if;
  if jsonb_typeof(next_metadata) <> 'object' then
    raise exception 'draft_metadata_invalid';
  end if;

  if jsonb_typeof(next_metadata -> 'activity') = 'array' then
    next_metadata := next_metadata || jsonb_build_object('activity', (
      select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
      from (
        select value, ord
        from jsonb_array_elements(next_metadata -> 'activity') with ordinality as item(value, ord)
        order by ord desc
        limit 100
      ) trimmed
    ));
  elsif next_metadata ? 'activity' then
    next_metadata := next_metadata - 'activity';
  end if;

  if jsonb_typeof(next_metadata -> 'submissionReceipts') = 'array' then
    next_metadata := next_metadata || jsonb_build_object('submissionReceipts', (
      select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
      from (
        select value, ord
        from jsonb_array_elements(next_metadata -> 'submissionReceipts') with ordinality as item(value, ord)
        order by ord desc
        limit 12
      ) trimmed
    ));
  elsif next_metadata ? 'submissionReceipts' then
    next_metadata := next_metadata - 'submissionReceipts';
  end if;

  begin
    next_draft_id := nullif(p_payload ->> 'draft_id', '')::uuid;
  exception
    when others then
      next_draft_id := gen_random_uuid();
  end;

  next_share_slug := coalesce(nullif(p_payload ->> 'share_slug', ''), encode(gen_random_bytes(16), 'hex'));
  next_collaboration_slug := coalesce(nullif(p_payload ->> 'collaboration_slug', ''), encode(gen_random_bytes(16), 'hex'));
  while next_collaboration_slug = next_share_slug loop
    next_collaboration_slug := encode(gen_random_bytes(16), 'hex');
  end loop;

  next_operator_slug := coalesce(nullif(p_payload ->> 'operator_slug', ''), encode(gen_random_bytes(16), 'hex'));
  while next_operator_slug = next_share_slug or next_operator_slug = next_collaboration_slug loop
    next_operator_slug := encode(gen_random_bytes(16), 'hex');
  end loop;

  insert into public.sa_transaction_drafts (
    draft_id,
    share_slug,
    collaboration_slug,
    operator_slug,
    status,
    account,
    operation_body,
    transaction_body,
    signer_requirements,
    signatures,
    broadcast_mode,
    metadata,
    share_path
  )
  values (
    coalesce(next_draft_id, gen_random_uuid()),
    next_share_slug,
    next_collaboration_slug,
    next_operator_slug,
    coalesce(nullif(p_payload ->> 'status', ''), 'draft'),
    coalesce(p_payload -> 'account', '{}'::jsonb),
    p_payload -> 'operation_body',
    p_payload -> 'transaction_body',
    next_signer_requirements,
    next_signatures,
    coalesce(nullif(p_payload ->> 'broadcast_mode', ''), 'client'),
    next_metadata,
    coalesce(nullif(p_payload ->> 'share_path', ''), '/tx/' || next_share_slug)
  )
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, 'operate', draft_row.operator_slug);
end;
$$;

create or replace function public.get_sa_draft_by_share_slug(p_share_slug text, p_access_slug text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
  access_scope text;
begin
  select * into draft_row
  from public.sa_transaction_drafts
  where share_slug = p_share_slug
  limit 1;

  if not found then
    raise exception 'draft_not_found';
  end if;

  access_scope := public.resolve_sa_draft_access_scope(draft_row, p_access_slug);
  return public.serialize_sa_transaction_draft(draft_row, access_scope, p_access_slug);
end;
$$;

create or replace function public.require_sa_draft_collaboration_access(p_share_slug text, p_access_slug text)
returns public.sa_transaction_drafts
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
begin
  select * into draft_row
  from public.sa_transaction_drafts
  where share_slug = p_share_slug
    and (collaboration_slug = p_access_slug or operator_slug = p_access_slug)
  limit 1;

  if not found then
    raise exception 'draft_collaboration_access_required';
  end if;

  return draft_row;
end;
$$;

create or replace function public.require_sa_draft_operator_access(p_share_slug text, p_access_slug text)
returns public.sa_transaction_drafts
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
begin
  select * into draft_row
  from public.sa_transaction_drafts
  where share_slug = p_share_slug
    and operator_slug = p_access_slug
  limit 1;

  if not found then
    raise exception 'draft_operator_access_required';
  end if;

  return draft_row;
end;
$$;

create or replace function public.append_sa_draft_signature(p_share_slug text, p_access_slug text, p_signature jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
  next_signatures jsonb;
  access_scope text;
begin
  -- Verify collaboration access first (unchanged)
  draft_row := public.require_sa_draft_collaboration_access(p_share_slug, p_access_slug);
  access_scope := public.resolve_sa_draft_access_scope(draft_row, p_access_slug);

  -- Re-select with FOR UPDATE to prevent TOCTOU race on signatures
  select * into draft_row
  from public.sa_transaction_drafts
  where draft_id = draft_row.draft_id
  for update;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(draft_row.signatures, '[]'::jsonb)) as item
    where item ->> 'kind' = p_signature ->> 'kind'
      and item ->> 'signerId' = p_signature ->> 'signerId'
  ) then
    return public.serialize_sa_transaction_draft(draft_row, access_scope, p_access_slug);
  end if;

  next_signatures := coalesce(draft_row.signatures, '[]'::jsonb) || jsonb_build_array(p_signature);

  update public.sa_transaction_drafts
  set signatures = next_signatures
  where draft_id = draft_row.draft_id
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, access_scope, p_access_slug);
end;
$$;

create or replace function public.set_sa_draft_status(p_share_slug text, p_access_slug text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
begin
  if p_status not in ('draft', 'broadcasted', 'relayed', 'completed', 'cancelled') then
    raise exception 'Invalid status: %', p_status;
  end if;

  draft_row := public.require_sa_draft_operator_access(p_share_slug, p_access_slug);

  update public.sa_transaction_drafts
  set status = p_status
  where draft_id = draft_row.draft_id
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, 'operate', p_access_slug);
end;
$$;

create or replace function public.patch_sa_draft_metadata(p_share_slug text, p_metadata_patch jsonb)
returns public.sa_transaction_drafts
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
begin
  update public.sa_transaction_drafts
  set metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata_patch, '{}'::jsonb)
  where share_slug = p_share_slug
  returning * into draft_row;

  if not found then
    raise exception 'draft_not_found';
  end if;

  return draft_row;
end;
$$;

create or replace function public.append_sa_draft_activity(p_share_slug text, p_access_slug text, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
  next_activity jsonb;
  access_scope text;
begin
  draft_row := public.require_sa_draft_collaboration_access(p_share_slug, p_access_slug);
  access_scope := public.resolve_sa_draft_access_scope(draft_row, p_access_slug);
  perform public.assert_sa_draft_activity_allowed(access_scope, p_event);

  -- Re-select with FOR UPDATE to prevent lost updates on metadata
  select * into draft_row
  from public.sa_transaction_drafts
  where draft_id = draft_row.draft_id
  for update;

  next_activity := (
    select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
    from (
      select value, ord
      from jsonb_array_elements(coalesce(draft_row.metadata -> 'activity', '[]'::jsonb) || jsonb_build_array(p_event)) with ordinality as item(value, ord)
      order by ord desc
      limit 100
    ) trimmed
  );

  update public.sa_transaction_drafts
  set metadata = coalesce(draft_row.metadata, '{}'::jsonb) || jsonb_build_object('activity', next_activity)
  where draft_id = draft_row.draft_id
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, access_scope, p_access_slug);
end;
$$;

create or replace function public.set_sa_draft_relay_preflight(p_share_slug text, p_access_slug text, p_relay_preflight jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
begin
  draft_row := public.require_sa_draft_operator_access(p_share_slug, p_access_slug);

  -- Re-select with FOR UPDATE to prevent lost updates on metadata
  select * into draft_row
  from public.sa_transaction_drafts
  where draft_id = draft_row.draft_id
  for update;

  update public.sa_transaction_drafts
  set metadata = coalesce(draft_row.metadata, '{}'::jsonb) || jsonb_build_object('relayPreflight', coalesce(p_relay_preflight, 'null'::jsonb))
  where draft_id = draft_row.draft_id
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, 'operate', p_access_slug);
end;
$$;

create or replace function public.append_sa_draft_submission_receipt(p_share_slug text, p_access_slug text, p_receipt jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
  next_receipts jsonb;
begin
  draft_row := public.require_sa_draft_operator_access(p_share_slug, p_access_slug);

  -- Re-select with FOR UPDATE to prevent lost updates on metadata
  select * into draft_row
  from public.sa_transaction_drafts
  where draft_id = draft_row.draft_id
  for update;

  next_receipts := (
    select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
    from (
      select value, ord
      from jsonb_array_elements(coalesce(draft_row.metadata -> 'submissionReceipts', '[]'::jsonb) || jsonb_build_array(p_receipt)) with ordinality as item(value, ord)
      order by ord desc
      limit 12
    ) trimmed
  );

  update public.sa_transaction_drafts
  set metadata = coalesce(draft_row.metadata, '{}'::jsonb) || jsonb_build_object('submissionReceipts', next_receipts)
  where draft_id = draft_row.draft_id
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, 'operate', p_access_slug);
end;
$$;

create or replace function public.rotate_sa_draft_collaboration_slug(p_share_slug text, p_access_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
  next_collaboration_slug text;
begin
  draft_row := public.require_sa_draft_operator_access(p_share_slug, p_access_slug);

  next_collaboration_slug := encode(gen_random_bytes(16), 'hex');
  while next_collaboration_slug = draft_row.share_slug or next_collaboration_slug = draft_row.collaboration_slug or next_collaboration_slug = draft_row.operator_slug loop
    next_collaboration_slug := encode(gen_random_bytes(16), 'hex');
  end loop;

  update public.sa_transaction_drafts
  set collaboration_slug = next_collaboration_slug
  where draft_id = draft_row.draft_id
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, 'operate', p_access_slug);
end;
$$;

create or replace function public.rotate_sa_draft_operator_slug(p_share_slug text, p_access_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_row public.sa_transaction_drafts;
  next_operator_slug text;
begin
  draft_row := public.require_sa_draft_operator_access(p_share_slug, p_access_slug);

  next_operator_slug := encode(gen_random_bytes(16), 'hex');
  while next_operator_slug = draft_row.share_slug or next_operator_slug = draft_row.collaboration_slug or next_operator_slug = draft_row.operator_slug loop
    next_operator_slug := encode(gen_random_bytes(16), 'hex');
  end loop;

  update public.sa_transaction_drafts
  set operator_slug = next_operator_slug
  where draft_id = draft_row.draft_id
  returning * into draft_row;

  return public.serialize_sa_transaction_draft(draft_row, 'operate', next_operator_slug);
end;
$$;
