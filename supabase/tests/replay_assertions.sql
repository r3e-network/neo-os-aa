-- Post-replay assertions for the Supabase migration chain.
-- Run by .github/workflows/supabase-migrations.yml.disabled against a scratch Postgres
-- (the workflow is disabled at HEAD, so until it is re-enabled this file is run by hand)
-- after every file in supabase/migrations/ has been applied in filename order.
-- Each block raises (failing the job) when the replayed end state regresses.

-- The four draft mutators that merge into row snapshots must lock the row
-- (20260327 FIX 3 for signatures, 20260611 FIX 1 for the metadata writers).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.append_sa_draft_signature(text, text, jsonb)',
    'public.append_sa_draft_activity(text, text, jsonb)',
    'public.set_sa_draft_relay_preflight(text, text, jsonb)',
    'public.append_sa_draft_submission_receipt(text, text, jsonb)'
  ] loop
    if to_regprocedure(fn) is null then
      raise exception 'expected % to exist after replay', fn;
    end if;
    if position('for update' in lower(pg_get_functiondef(to_regprocedure(fn)))) = 0 then
      raise exception 'expected % to lock the draft row with FOR UPDATE', fn;
    end if;
  end loop;
end $$;

-- Legacy single-access-slug RPC signatures must not survive a replay.
do $$
begin
  if to_regprocedure('public.set_sa_draft_relay_preflight(text, jsonb)') is not null
    or to_regprocedure('public.append_sa_draft_submission_receipt(text, jsonb)') is not null then
    raise exception 'legacy single-access-slug RPC signatures must not survive a replay';
  end if;
end $$;

-- The internal activity-scope helper must not be executable by anon
-- (20260611 FIX 3).
do $$
begin
  if has_function_privilege('anon', 'public.assert_sa_draft_activity_allowed(text, jsonb)', 'execute') then
    raise exception 'anon must not be able to execute assert_sa_draft_activity_allowed';
  end if;
end $$;

-- The performance indexes must converge on the live end state: the four kept
-- indexes exist and the share_slug duplicate stays dropped (20260327 FIX 5).
do $$
declare
  idx text;
begin
  foreach idx in array array[
    'idx_sa_drafts_operator_slug',
    'idx_sa_drafts_collaboration_slug',
    'idx_sa_drafts_status',
    'idx_sa_drafts_created_at'
  ] loop
    if not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and indexname = idx
    ) then
      raise exception 'expected index % to exist after replay', idx;
    end if;
  end loop;

  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname in ('idx_aa_drafts_share_slug', 'idx_sa_drafts_share_slug')
  ) then
    raise exception 'the share_slug duplicate index must stay dropped (20260327_security_hardening.sql)';
  end if;
end $$;

-- create_sa_draft must reject oversized payloads (20260611 FIX 2).
do $$
begin
  begin
    perform public.create_sa_draft(jsonb_build_object(
      'operation_body', jsonb_build_object('blob', repeat('x', 70000))
    ));
    raise exception 'oversized create_sa_draft payload was accepted';
  exception
    when others then
      if sqlerrm <> 'draft_payload_too_large' then
        raise;
      end if;
  end;
end $$;

-- create_sa_draft must reject non-array or oversized signer/signature inputs.
do $$
declare
  oversized jsonb;
begin
  begin
    perform public.create_sa_draft(jsonb_build_object('signer_requirements', jsonb_build_object('not', 'an array')));
    raise exception 'non-array signer_requirements payload was accepted';
  exception
    when others then
      if sqlerrm <> 'draft_signer_requirements_invalid' then
        raise;
      end if;
  end;

  select jsonb_agg(jsonb_build_object('signerId', 'signer-' || i)) into oversized
  from generate_series(1, 101) as i;

  begin
    perform public.create_sa_draft(jsonb_build_object('signatures', oversized));
    raise exception 'oversized signatures payload was accepted';
  exception
    when others then
      if sqlerrm <> 'draft_signatures_invalid' then
        raise;
      end if;
  end;
end $$;

-- create_sa_draft must trim inbound metadata to the append-RPC bounds: latest
-- 100 activity entries and latest 12 submission receipts.
do $$
declare
  inbound_activity jsonb;
  inbound_receipts jsonb;
  created jsonb;
begin
  select jsonb_agg(jsonb_build_object('type', 'signature_added', 'seq', i)) into inbound_activity
  from generate_series(1, 150) as i;

  select jsonb_agg(jsonb_build_object('txid', 'tx-' || i, 'seq', i)) into inbound_receipts
  from generate_series(1, 20) as i;

  created := public.create_sa_draft(jsonb_build_object(
    'metadata', jsonb_build_object(
      'activity', inbound_activity,
      'submissionReceipts', inbound_receipts,
      'note', 'replay-trim-check'
    )
  ));

  if jsonb_array_length(created -> 'metadata' -> 'activity') <> 100 then
    raise exception 'expected inbound activity trimmed to 100 entries, got %',
      jsonb_array_length(created -> 'metadata' -> 'activity');
  end if;
  if (created -> 'metadata' -> 'activity' -> 0 ->> 'seq') <> '51' then
    raise exception 'expected trimmed activity to keep the latest 100 entries';
  end if;

  if jsonb_array_length(created -> 'metadata' -> 'submissionReceipts') <> 12 then
    raise exception 'expected inbound receipts trimmed to 12 entries, got %',
      jsonb_array_length(created -> 'metadata' -> 'submissionReceipts');
  end if;
  if (created -> 'metadata' -> 'submissionReceipts' -> 0 ->> 'seq') <> '9' then
    raise exception 'expected trimmed receipts to keep the latest 12 entries';
  end if;

  if created -> 'metadata' ->> 'note' <> 'replay-trim-check' then
    raise exception 'expected untouched metadata keys to persist through trimming';
  end if;
end $$;

-- End-to-end draft lifecycle against the replayed function chain: read links
-- stay read-only, collaborator links sign, operator links mutate, and the
-- metadata writers preserve each other's keys.
do $$
declare
  created jsonb;
  fetched jsonb;
  updated jsonb;
  v_share_slug text;
  v_collaboration_slug text;
  v_operator_slug text;
begin
  created := public.create_sa_draft(jsonb_build_object(
    'account', jsonb_build_object('label', 'replay-check'),
    'signer_requirements', jsonb_build_array(jsonb_build_object('signerId', 'signer-1', 'kind', 'neo'))
  ));
  v_share_slug := created ->> 'share_slug';
  v_collaboration_slug := created ->> 'collaboration_slug';
  v_operator_slug := created ->> 'operator_slug';

  fetched := public.get_sa_draft_by_share_slug(v_share_slug, null);
  if (fetched ->> 'can_write')::boolean then
    raise exception 'public share link must stay read-only';
  end if;

  updated := public.append_sa_draft_signature(v_share_slug, v_collaboration_slug,
    jsonb_build_object('kind', 'neo', 'signerId', 'signer-1', 'signature', 'replay-sig'));
  if jsonb_array_length(updated -> 'signatures') <> 1 then
    raise exception 'expected appended signature to persist';
  end if;

  updated := public.append_sa_draft_activity(v_share_slug, v_collaboration_slug,
    jsonb_build_object('type', 'signature_added'));
  if jsonb_array_length(updated -> 'metadata' -> 'activity') <> 1 then
    raise exception 'expected appended activity entry to persist';
  end if;

  updated := public.set_sa_draft_relay_preflight(v_share_slug, v_operator_slug,
    jsonb_build_object('ok', true));
  if updated -> 'metadata' -> 'relayPreflight' is null
    or jsonb_array_length(updated -> 'metadata' -> 'activity') <> 1 then
    raise exception 'relay preflight write must preserve other metadata keys';
  end if;

  updated := public.append_sa_draft_submission_receipt(v_share_slug, v_operator_slug,
    jsonb_build_object('txid', '0xreplay'));
  if jsonb_array_length(updated -> 'metadata' -> 'submissionReceipts') <> 1
    or updated -> 'metadata' -> 'relayPreflight' is null then
    raise exception 'submission receipt write must preserve other metadata keys';
  end if;

  updated := public.set_sa_draft_status(v_share_slug, v_operator_slug, 'broadcasted');
  if updated ->> 'status' <> 'broadcasted' then
    raise exception 'expected operator status mutation to apply';
  end if;
end $$;

-- Leave the scratch database clean for any follow-up checks.
delete from public.sa_transaction_drafts;
