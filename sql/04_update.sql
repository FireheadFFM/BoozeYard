-- BoozeYard Update 8: Nachkaufen, Einkaufspreise, Lieferscheine
-- Im Supabase SQL Editor einmal ausführen (kann gefahrlos mehrfach laufen).

alter table bottles add column if not exists reorder boolean not null default false;
alter table bottles add column if not exists last_price numeric(9,2);
alter table bottles add column if not exists supplier_sku text;

alter table deliveries add column if not exists invoice_no text;
alter table deliveries add column if not exists total numeric(10,2);
