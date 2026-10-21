-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run (여러 번 실행해도 안전)
--
-- 브라우저는 테이블에 직접 접근하지 못하고 아래 함수(RPC)로만 읽고 쓴다.
-- 방은 ID를 알아야만 조회되고, 응답은 이름별 4자리 PIN이 맞아야 수정된다.

create extension if not exists pgcrypto with schema extensions;

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

alter table responses add column if not exists pin_hash text;

-- 테이블 직접 접근 차단 (RLS 켜고 정책 없음 + 권한 회수)
alter table rooms enable row level security;
alter table responses enable row level security;
drop policy if exists "rooms read" on rooms;
drop policy if exists "rooms insert" on rooms;
drop policy if exists "responses read" on responses;
drop policy if exists "responses insert" on responses;
drop policy if exists "responses update" on responses;
drop policy if exists "responses delete" on responses;
revoke all on table rooms, responses from anon, authenticated;

-- 방 하나 + 응답 목록 (PIN 해시는 절대 내보내지 않음)
create or replace function get_room(p_id text) returns json
language sql stable security definer set search_path = public as $$
  select case when r.id is null then null else json_build_object(
    'room', json_build_object('id', r.id, 'title', r.title, 'start_date', r.start_date,
                              'end_date', r.end_date, 'total_people', r.total_people),
    'responses', coalesce((
      select json_agg(json_build_object('name', s.name, 'dates', s.dates) order by s.updated_at)
      from responses s where s.room_id = r.id), '[]'::json)
  ) end
  from (select 1) _ left join rooms r on r.id = p_id;
$$;

create or replace function create_room(p_title text, p_start date, p_end date, p_total int) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id text;
  chars text := 'abcdefghijkmnpqrstuvwxyz23456789';
  b bytea;
  i int;
begin
  p_title := trim(p_title);
  if p_title = '' or length(p_title) > 40 then raise exception 'invalid title'; end if;
  if p_end < p_start or p_end - p_start > 61 then raise exception 'invalid range'; end if;
  loop
    b := gen_random_bytes(8);
    v_id := '';
    for i in 0..7 loop v_id := v_id || substr(chars, 1 + get_byte(b, i) % 32, 1); end loop;
    exit when not exists (select 1 from rooms where id = v_id);
  end loop;
  insert into rooms (id, title, start_date, end_date, total_people)
  values (v_id, p_title, p_start, p_end, case when p_total between 1 and 50 then p_total end);
  return v_id;
end $$;

-- 입장 시 PIN 확인: 없는 이름이거나 PIN 미설정(구버전 응답)이면 true
create or replace function check_pin(p_room text, p_name text, p_pin text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select pin_hash is null or pin_hash = crypt(p_pin, pin_hash)
                   from responses where room_id = p_room and name = p_name), true);
$$;

create or replace function save_response(p_room text, p_name text, p_pin text, p_dates text[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text;
begin
  p_name := trim(p_name);
  if p_name = '' or length(p_name) > 20 then raise exception 'invalid name'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'invalid pin'; end if;
  if coalesce(array_length(p_dates, 1), 0) > 62 then raise exception 'too many dates'; end if;

  select pin_hash into v_hash from responses where room_id = p_room and name = p_name for update;
  if found then
    if v_hash is not null and v_hash <> crypt(p_pin, v_hash) then raise exception 'wrong pin'; end if;
    update responses
       set dates = p_dates, updated_at = now(),
           pin_hash = coalesce(v_hash, crypt(p_pin, gen_salt('bf')))
     where room_id = p_room and name = p_name;
  else
    insert into responses (room_id, name, dates, pin_hash)
    values (p_room, p_name, p_dates, crypt(p_pin, gen_salt('bf')));
  end if;
end $$;

create or replace function delete_response(p_room text, p_name text, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not check_pin(p_room, p_name, p_pin) then raise exception 'wrong pin'; end if;
  delete from responses where room_id = p_room and name = p_name;
end $$;

revoke all on function get_room(text), create_room(text, date, date, int),
  check_pin(text, text, text), save_response(text, text, text, text[]),
  delete_response(text, text, text) from public;
grant execute on function get_room(text), create_room(text, date, date, int),
  check_pin(text, text, text), save_response(text, text, text, text[]),
  delete_response(text, text, text) to anon, authenticated;
