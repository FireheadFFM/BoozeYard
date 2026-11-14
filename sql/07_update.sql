-- BoozeYard Update 11: YouTube-Rezepte für den Chat-Assistenten
-- Im Supabase SQL Editor einmal ausführen (kann gefahrlos mehrfach laufen).

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  video_id text not null,
  title text not null,
  description text,
  published_at timestamptz,
  duration_s integer,
  cocktail text,
  ingredients jsonb,
  is_recipe boolean,
  extracted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, video_id)
);

alter table recipes enable row level security;

drop policy if exists "recipes eigene" on recipes;
create policy "recipes eigene" on recipes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on recipes to authenticated;
