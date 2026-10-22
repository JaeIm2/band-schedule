-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run (여러 번 실행해도 안전)
--
-- 브라우저는 테이블에 직접 접근하지 못하고 아래 함수(RPC)로만 읽고 쓴다.
-- 방은 ID를 알아야만 조회되고, 응답은 이름별 4자리 PIN이 맞아야 수정된다.
-- 방 수정·삭제·확정·PIN 초기화는 방 만들 때 한 번 발급하는 관리 키로만 가능하다.

create extension if not exists pgcrypto with schema extensions;

-- ---------- 테이블 ----------
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
alter table rooms add column if not exists admin_hash text;
alter table rooms add column if not exists members text[] not null default '{}'; -- 미리 등록한 멤버 (비면 누구나 입장)
alter table rooms add column if not exists confirmed_date date;                  -- 관리자가 확정한 날짜

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

-- 예전 시그니처 정리 (인자가 바뀐 함수)
drop function if exists create_room(text, date, date, int);
drop function if exists admin_update_room(text, text, text, date, date, int);

-- ---------- 공용 ----------
-- 멤버 목록 정리: 공백 제거, 빈 값·중복 제거, 입력 순서 유지
create or replace function clean_members(p text[]) returns text[]
language plpgsql immutable set search_path = public as $$
declare v text[];
begin
  v := array(
    select t from (
      select trim(m) t, min(ord) o
      from unnest(coalesce(p, '{}')) with ordinality u(m, ord)
      where trim(m) <> '' group by trim(m)
    ) x order by o);
  if array_length(v, 1) > 50 then raise exception 'too many members'; end if;
  if exists (select 1 from unnest(v) n where length(n) > 20) then raise exception 'invalid name'; end if;
  return v;
end $$;

-- 방 하나 + 응답 목록 (PIN 해시·관리 키 해시는 절대 내보내지 않음)
create or replace function get_room(p_id text) returns json
language sql stable security definer set search_path = public as $$
  select case when r.id is null then null else json_build_object(
    'room', json_build_object('id', r.id, 'title', r.title, 'start_date', r.start_date,
                              'end_date', r.end_date, 'total_people', r.total_people,
                              'members', r.members, 'confirmed_date', r.confirmed_date),
    'responses', coalesce((
      select json_agg(json_build_object('name', s.name, 'dates', s.dates) order by s.updated_at)
      from responses s where s.room_id = r.id), '[]'::json)
  ) end
  from (select 1) _ left join rooms r on r.id = p_id;
$$;

create or replace function create_room(p_title text, p_start date, p_end date, p_total int, p_members text[] default '{}')
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id text;
  v_key text := '';
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
  b := gen_random_bytes(16);
  for i in 0..15 loop v_key := v_key || substr(chars, 1 + get_byte(b, i) % 32, 1); end loop;
  insert into rooms (id, title, start_date, end_date, total_people, members, admin_hash)
  values (v_id, p_title, p_start, p_end, case when p_total between 1 and 50 then p_total end,
          clean_members(p_members), encode(digest(v_key, 'sha256'), 'hex'));
  return json_build_object('id', v_id, 'admin_key', v_key);
end $$;

-- ---------- 참여자 ----------
-- 입장 시 PIN 확인: 없는 이름이거나 PIN 미설정(구버전 응답·초기화)이면 true
create or replace function check_pin(p_room text, p_name text, p_pin text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select pin_hash is null or pin_hash = crypt(p_pin, pin_hash)
                   from responses where room_id = p_room and name = p_name), true);
$$;

create or replace function save_response(p_room text, p_name text, p_pin text, p_dates text[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text;
  v_members text[];
begin
  p_name := trim(p_name);
  if p_name = '' or length(p_name) > 20 then raise exception 'invalid name'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'invalid pin'; end if;
  if coalesce(array_length(p_dates, 1), 0) > 62 then raise exception 'too many dates'; end if;
  select members into v_members from rooms where id = p_room;
  if cardinality(v_members) > 0 and not p_name = any(v_members) then raise exception 'not member'; end if;

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

-- ---------- 관리 ----------
create or replace function check_admin(p_room text, p_key text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select admin_hash = encode(digest(p_key, 'sha256'), 'hex')
                   from rooms where id = p_room), false);
$$;

create or replace function admin_update_room(p_room text, p_key text, p_title text, p_start date, p_end date,
                                             p_total int, p_members text[] default '{}') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not check_admin(p_room, p_key) then raise exception 'not admin'; end if;
  p_title := trim(p_title);
  if p_title = '' or length(p_title) > 40 then raise exception 'invalid title'; end if;
  if p_end < p_start or p_end - p_start > 61 then raise exception 'invalid range'; end if;
  update rooms set title = p_title, start_date = p_start, end_date = p_end,
         total_people = case when p_total between 1 and 50 then p_total end,
         members = clean_members(p_members),
         -- 기간 밖으로 밀려난 확정 날짜는 해제
         confirmed_date = case when confirmed_date between p_start and p_end then confirmed_date end
   where id = p_room;
end $$;

-- p_date 가 null 이면 확정 취소
create or replace function admin_confirm(p_room text, p_key text, p_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not check_admin(p_room, p_key) then raise exception 'not admin'; end if;
  if p_date is not null and not exists (
    select 1 from rooms where id = p_room and p_date between start_date and end_date
  ) then raise exception 'invalid date'; end if;
  update rooms set confirmed_date = p_date where id = p_room;
end $$;

create or replace function admin_delete_room(p_room text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not check_admin(p_room, p_key) then raise exception 'not admin'; end if;
  delete from rooms where id = p_room;
end $$;

create or replace function admin_reset_pin(p_room text, p_key text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not check_admin(p_room, p_key) then raise exception 'not admin'; end if;
  update responses set pin_hash = null where room_id = p_room and name = p_name;
end $$;

create or replace function admin_delete_response(p_room text, p_key text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not check_admin(p_room, p_key) then raise exception 'not admin'; end if;
  delete from responses where room_id = p_room and name = p_name;
end $$;

-- ---------- 실행 권한 ----------
revoke all on function clean_members(text[]), get_room(text),
  create_room(text, date, date, int, text[]),
  check_pin(text, text, text), save_response(text, text, text, text[]), delete_response(text, text, text),
  check_admin(text, text), admin_update_room(text, text, text, date, date, int, text[]),
  admin_confirm(text, text, date), admin_delete_room(text, text),
  admin_reset_pin(text, text, text), admin_delete_response(text, text, text) from public;
grant execute on function get_room(text),
  create_room(text, date, date, int, text[]),
  check_pin(text, text, text), save_response(text, text, text, text[]), delete_response(text, text, text),
  check_admin(text, text), admin_update_room(text, text, text, date, date, int, text[]),
  admin_confirm(text, text, date), admin_delete_room(text, text),
  admin_reset_pin(text, text, text), admin_delete_response(text, text, text) to anon, authenticated;
