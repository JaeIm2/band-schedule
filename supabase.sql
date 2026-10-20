-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run

create table if not exists rooms (
  id text primary key,
  title text not null,
  start_date date not null,
  end_date date not null,
  total_people int,
  created_at timestamptz not null default now()
);

create table if not exists responses (
  room_id text not null references rooms(id) on delete cascade,
  name text not null,
  dates text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (room_id, name)
);

alter table rooms enable row level security;
alter table responses enable row level security;

-- 링크 아는 사람끼리 쓰는 개인용이라 익명 읽기/쓰기 허용
create policy "rooms read" on rooms for select using (true);
create policy "rooms insert" on rooms for insert with check (true);

create policy "responses read" on responses for select using (true);
create policy "responses insert" on responses for insert with check (true);
create policy "responses update" on responses for update using (true) with check (true);
create policy "responses delete" on responses for delete using (true);
