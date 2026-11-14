-- BoozeYard Update 10: Merkliste für den Chat-Assistenten
-- Im Supabase SQL Editor einmal ausführen (kann gefahrlos mehrfach laufen).

create table if not exists chat_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  text text not null,
  created_at timestamptz not null default now()
);

alter table chat_notes enable row level security;

drop policy if exists "chat_notes eigene" on chat_notes;
create policy "chat_notes eigene" on chat_notes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on chat_notes to authenticated;
