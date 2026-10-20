(function () {
  const CFG = window.APP_CONFIG || {};
  const DOW = ["월", "화", "수", "목", "금", "토", "일"];
  const MAX_DAYS = 62;
  const $ = (id) => document.getElementById(id);
  const show = (el, on) => el.classList.toggle("hidden", !on);

  // ---------- 날짜 유틸 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const dowIdx = (d) => (d.getDay() + 6) % 7; // 월=0
  const fmt = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[dowIdx(d)]})`;
  const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const TODAY_ISO = iso(today);

  // ---------- localStorage (실패해도 동작) ----------
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    show(t, true);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => show(t, false), 1800);
  }

  // ---------- 시작 ----------
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) { show($("view-setup"), true); return; }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
  const roomId = new URLSearchParams(location.search).get("r");

  if (roomId) initRoom(roomId);
  else initCreate();

  // =====================================================
  // 방 만들기
  // =====================================================
  function initCreate() {
    show($("view-create"), true);
    $("c-start").value = TODAY_ISO;
    $("c-end").value = iso(addDays(today, 20));

    $("create-btn").addEventListener("click", async () => {
      const status = $("create-status");
      status.classList.remove("err");
      const title = $("c-title").value.trim();
      const s = $("c-start").value, e = $("c-end").value;
      const total = parseInt($("c-total").value, 10);
      const fail = (m) => { status.textContent = m; status.classList.add("err"); };

      if (!title) return fail("제목을 입력해주세요.");
      if (!s || !e) return fail("기간을 입력해주세요.");
      const days = Math.round((parse(e) - parse(s)) / 86400000) + 1;
      if (days < 1) return fail("종료일이 시작일보다 빨라요.");
      if (days > MAX_DAYS) return fail(`기간은 최대 ${MAX_DAYS}일까지 가능해요.`);

      const id = randomId();
      $("create-btn").disabled = true;
      status.textContent = "만드는 중…";
      const { error } = await sb.from("rooms").insert({
        id, title, start_date: s, end_date: e,
        total_people: Number.isFinite(total) && total > 0 ? total : null,
      });
      $("create-btn").disabled = false;
      if (error) return fail("생성 실패: " + error.message);
      location.href = `?r=${id}`;
    });
  }

  function randomId() {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => chars[b % chars.length]).join("");
  }

  // =====================================================
  // 방
  // =====================================================
  async function initRoom(id) {
    const { data: room, error } = await sb.from("rooms").select("*").eq("id", id).maybeSingle();
    if (error || !room) {
      $("range-label").textContent = error ? "불러오기 실패: " + error.message : "없는 일정이에요. 링크를 확인해주세요.";
      return;
    }

    const start = parse(room.start_date);
    const DAYS = Math.round((parse(room.end_date) - start) / 86400000) + 1;
    const dates = Array.from({ length: DAYS }, (_, i) => addDays(start, i));
    const ISO = dates.map(iso);
    const leadPad = dowIdx(start);
    const weekOf = (i) => Math.floor((i + leadPad) / 7); // 달력 줄 기준 주차
    const WEEKS = weekOf(DAYS - 1) + 1;
    const TOTAL = room.total_people;
    const nameKey = `bs:name:${id}`;

    document.title = `${room.title} · 일정 맞추기`;
    $("title").textContent = room.title;
    $("range-label").textContent = `${fmt(dates[0])} ~ ${fmt(dates[DAYS - 1])}` + (TOTAL ? ` · ${TOTAL}명` : "");

    let me = null;
    let selected = new Set();
    let all = []; // [{name, dates}]
    let detailIso = null;

    // ---------- 링크 복사 ----------
    const copyLink = async () => {
      const url = location.origin + location.pathname + `?r=${id}`;
      try { await navigator.clipboard.writeText(url); toast("링크를 복사했어요"); }
      catch { prompt("이 링크를 복사하세요", url); }
    };
    $("copy-btn").addEventListener("click", copyLink);
    $("copy-btn2").addEventListener("click", copyLink);

    // ---------- 툴바 ----------
    const tb = $("toolbar");
    const chip = (label, cls, fn) => {
      const b = document.createElement("button");
      b.className = "chip" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      tb.appendChild(b);
    };
    chip("전체 선택", "", () => { ISO.forEach((d) => selected.add(d)); changed(); });
    if (WEEKS > 1) {
      for (let w = 0; w < WEEKS; w++) {
        const idx = ISO.map((_, i) => i).filter((i) => weekOf(i) === w);
        const a = dates[idx[0]], z = dates[idx[idx.length - 1]];
        chip(`${w + 1}주차 ${md(a)}~${md(z)}`, "", () => {
          const allOn = idx.every((i) => selected.has(ISO[i]));
          idx.forEach((i) => allOn ? selected.delete(ISO[i]) : selected.add(ISO[i]));
          changed();
        });
      }
    }
    chip("주말만", "", () => {
      ISO.forEach((d, i) => { if (dowIdx(dates[i]) >= 5) selected.add(d); });
      changed();
    });
    chip("모두 해제", "danger", () => { selected.clear(); changed(); });

    // ---------- 달력 ----------
    function buildCalendar(c) {
      c.innerHTML = "";
      DOW.forEach((n, i) => {
        const el = document.createElement("div");
        el.className = "dow" + (i === 6 ? " sun" : "");
        el.textContent = n;
        c.appendChild(el);
      });
      for (let p = 0; p < leadPad; p++) {
        const e = document.createElement("div");
        e.className = "day pad";
        c.appendChild(e);
      }
      return dates.map((d, i) => {
        const el = document.createElement("div");
        el.className = "day" + (dowIdx(d) === 6 ? " sun" : "") + (ISO[i] === TODAY_ISO ? " today" : "");
        el.dataset.iso = ISO[i];
        el.innerHTML = `<div class="d">${d.getDate()}</div><div class="m">${d.getMonth() + 1}월</div>`;
        c.appendChild(el);
        return el;
      });
    }

    // 선택 달력: 누르고 드래그하면 여러 날 한 번에 칠하기
    const pickCells = buildCalendar($("pick-calendar"));
    let paint = null; // true=선택, false=해제
    const cellAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el && el.closest("#pick-calendar .day[data-iso]");
    };
    const apply = (el) => {
      if (!el) return;
      const d = el.dataset.iso;
      if (paint ? selected.has(d) : !selected.has(d)) return;
      paint ? selected.add(d) : selected.delete(d);
      renderPick();
    };
    $("pick-calendar").addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".day[data-iso]");
      if (!el) return;
      e.preventDefault();
      paint = !selected.has(el.dataset.iso);
      apply(el);
    });
    window.addEventListener("pointermove", (e) => { if (paint !== null) apply(cellAt(e.clientX, e.clientY)); });
    const endPaint = () => { if (paint !== null) { paint = null; changed(); } };
    window.addEventListener("pointerup", endPaint);
    window.addEventListener("pointercancel", endPaint);

    function renderPick() {
      pickCells.forEach((el) => el.classList.toggle("on", selected.has(el.dataset.iso)));
      $("pick-count").textContent = `${selected.size} / ${DAYS}일 선택`;
    }

    // ---------- 저장 (자동) ----------
    let saveTimer = null;
    function changed() {
      renderPick();
      const st = $("save-status");
      st.classList.remove("err");
      st.textContent = "저장 대기…";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 600);
    }
    async function save() {
      const st = $("save-status");
      st.textContent = "저장 중…";
      const sorted = [...selected].sort();
      const { error } = await sb.from("responses").upsert({
        room_id: id, name: me, dates: sorted, updated_at: new Date().toISOString(),
      });
      if (error) { st.textContent = "저장 실패: " + error.message; st.classList.add("err"); return; }
      st.textContent = "저장됨 ✓";
      const mine = all.find((p) => p.name === me);
      if (mine) mine.dates = sorted; else all.push({ name: me, dates: sorted });
      renderSummary();
    }

    // ---------- 데이터 ----------
    async function load() {
      const { data, error } = await sb.from("responses").select("name, dates").eq("room_id", id).order("updated_at");
      if (error) { toast("불러오기 실패: " + error.message); return false; }
      all = data;
      return true;
    }

    // ---------- 종합 ----------
    const sumCells = buildCalendar($("summary-calendar"));
    sumCells.forEach((el) => {
      el.addEventListener("click", () => {
        detailIso = detailIso === el.dataset.iso ? null : el.dataset.iso;
        renderSummary();
      });
    });

    function whoOn(d) { return all.filter((p) => p.dates.includes(d)).map((p) => p.name); }

    function renderSummary() {
      const n = all.length;
      const denom = TOTAL || n || 1;
      $("people-count").textContent = TOTAL ? `(${n}/${TOTAL}명 입력)` : `(${n}명 입력)`;

      const counts = ISO.map((d) => whoOn(d));
      sumCells.forEach((el, i) => {
        const names = counts[i];
        const full = names.length > 0 && names.length >= denom;
        el.classList.toggle("full", full);
        el.classList.toggle("sel", el.dataset.iso === detailIso);
        el.style.background = full || !names.length ? "" : `rgba(var(--heat), ${0.12 + 0.55 * (names.length / denom)})`;
        let extra = el.querySelector(".names");
        if (!extra) {
          extra = document.createElement("div"); extra.className = "names"; el.appendChild(extra);
          const c = document.createElement("div"); c.className = "cnt"; el.appendChild(c);
        }
        extra.textContent = names.join(", ");
        el.querySelector(".cnt").textContent = names.length ? `${names.length}/${denom}` : "";
      });

      // 베스트 날짜
      const best = $("best");
      best.innerHTML = "";
      if (!n) { best.textContent = "아직 아무도 입력하지 않았어요."; }
      else {
        const ranked = ISO.map((d, i) => ({ i, c: counts[i].length })).filter((x) => x.c > 0)
          .sort((a, b) => b.c - a.c || a.i - b.i);
        const fullDays = ranked.filter((x) => x.c >= denom);
        const line = document.createElement("div");
        if (fullDays.length) {
          line.innerHTML = `<b class="full">전원 가능:</b> `;
          line.append(fullDays.sort((a, b) => a.i - b.i).map((x) => fmt(dates[x.i])).join(", "));
        } else if (ranked.length) {
          line.innerHTML = `<b>전원 되는 날은 없어요.</b> 많이 되는 날 순:`;
        } else {
          line.textContent = "겹치는 날짜가 없어요.";
        }
        best.appendChild(line);
        if (!fullDays.length && ranked.length) {
          const ol = document.createElement("ol");
          ranked.slice(0, 5).forEach((x) => {
            const li = document.createElement("li");
            const missing = all.map((p) => p.name).filter((nm) => !counts[x.i].includes(nm));
            li.textContent = `${fmt(dates[x.i])} — ${x.c}명`;
            if (missing.length) {
              const s = document.createElement("span");
              s.className = "muted";
              s.textContent = `(안 됨: ${missing.join(", ")})`;
              li.appendChild(s);
            }
            ol.appendChild(li);
          });
          best.appendChild(ol);
        }
      }

      // 선택한 날짜 상세
      const det = $("detail");
      if (detailIso) {
        const yes = whoOn(detailIso);
        const no = all.map((p) => p.name).filter((nm) => !yes.includes(nm));
        det.innerHTML = "";
        const h = document.createElement("strong"); h.textContent = fmt(parse(detailIso)); det.appendChild(h);
        const y = document.createElement("div"); y.textContent = `되는 사람 (${yes.length}): ${yes.join(", ") || "-"}`; det.appendChild(y);
        const nn = document.createElement("div"); nn.className = "no"; nn.textContent = `안 되는 사람 (${no.length}): ${no.join(", ") || "-"}`; det.appendChild(nn);
        show(det, true);
      } else show(det, false);

      // 참여자 목록
      const pl = $("people");
      pl.innerHTML = "";
      all.forEach((p) => {
        const s = document.createElement("span");
        if (p.name === me) s.className = "me";
        s.textContent = `${p.name} · ${p.dates.length}일`;
        pl.appendChild(s);
      });
    }

    // ---------- 로그인 ----------
    async function enter(name) {
      me = name;
      store.set(nameKey, name);
      await load();
      const mine = all.find((p) => p.name === me);
      selected = new Set(mine ? mine.dates : []);
      $("me-label").textContent = me;
      $("save-status").textContent = mine ? "" : "날짜를 누르면 자동 저장돼요";
      show($("view-login"), false);
      show($("view-pick"), true);
      show($("view-summary"), true);
      renderPick();
      renderSummary();
    }

    $("enter-btn").addEventListener("click", () => {
      const v = $("name-input").value.trim();
      if (v) enter(v); else $("name-input").focus();
    });
    $("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) $("enter-btn").click(); });
    $("logout-btn").addEventListener("click", () => {
      me = null;
      store.del(nameKey);
      $("name-input").value = "";
      show($("view-pick"), false);
      show($("view-login"), true);
    });
    $("delete-btn").addEventListener("click", async () => {
      if (!confirm(`'${me}' 응답을 삭제할까요?`)) return;
      clearTimeout(saveTimer);
      const { error } = await sb.from("responses").delete().eq("room_id", id).eq("name", me);
      if (error) { toast("삭제 실패: " + error.message); return; }
      all = all.filter((p) => p.name !== me);
      $("logout-btn").click();
      renderSummary();
      toast("삭제했어요");
    });
    $("refresh-btn").addEventListener("click", async () => { if (await load()) { renderSummary(); toast("새로고침했어요"); } });
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible" && await load()) renderSummary();
    });

    const saved = store.get(nameKey, null);
    if (saved) enter(saved);
    else {
      show($("view-login"), true);
      show($("view-summary"), true);
      await load();
      renderSummary();
    }
  }
})();
