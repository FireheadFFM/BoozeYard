-- BoozeYard Update 12: Standardstatus pro Lagerort
-- Im Supabase SQL Editor einmal ausführen (kann gefahrlos mehrfach laufen).

alter table locations add column if not exists default_status text;
