-- BoozeYard Update 9: freie Einträge auf der Einkaufsliste (Wunschliste)
-- Im Supabase SQL Editor einmal ausführen (kann gefahrlos mehrfach laufen).

alter table wishlist add column if not exists quantity integer not null default 1;
alter table wishlist add column if not exists size_ml integer;
