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

      $("create-btn").disabled = true;
      status.textContent = "만드는 중…";
      const { data: id, error } = await sb.rpc("create_room", {
        p_title: title, p_start: s, p_end: e,
        p_total: Number.isFinite(total) && total > 0 ? total : null,
      });
      $("create-btn").disabled = false;
      if (error) return fail("생성 실패: " + error.message);
      location.href = `?r=${id}`;
    });
  }

  // =====================================================
  // 방
  // =====================================================
  async function initRoom(id) {
    const { data: init, error } = await sb.rpc("get_room", { p_id: id });
    if (error || !init) {
      $("range-label").textContent = error ? "불러오기 실패: " + error.message : "없는 일정이에요. 링크를 확인해주세요.";
      return;
    }
    const room = init.room;

    const start = parse(room.start_date);
    const DAYS = Math.round((parse(room.end_date) - start) / 86400000) + 1;
    const dates = Array.from({ length: DAYS }, (_, i) => addDays(start, i));
    const ISO = dates.map(iso);
    const leadPad = dowIdx(start);
    const weekOf = (i) => Math.floor((i + leadPad) / 7); // 달력 줄 기준 주차
    const WEEKS = weekOf(DAYS - 1) + 1;
    const TOTAL = room.total_people;
    const nameKey = `bs:name:${id}`;
    const isPast = (d) => d < TODAY_ISO;
    const OPEN = ISO.filter((d) => !isPast(d)); // 오늘 이후라 고를 수 있는 날

    document.title = `${room.title} · 일정 맞추기`;
    $("title").textContent = room.title;
    $("range-label").textContent = `${fmt(dates[0])} ~ ${fmt(dates[DAYS - 1])}` + (TOTAL ? ` · ${TOTAL}명` : "");

    let me = null;
    let myPin = null;
    let selected = new Set();
    let all = init.responses; // [{name, dates}]
    let detailIso = null;
    let focusName = null; // 참여자 칩을 누르면 그 사람 날짜만 보기

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
    chip("전체 선택", "", () => { OPEN.forEach((d) => selected.add(d)); changed(); });
    if (WEEKS > 1) {
      for (let w = 0; w < WEEKS; w++) {
        const idx = ISO.map((_, i) => i).filter((i) => weekOf(i) === w && !isPast(ISO[i]));
        if (!idx.length) continue;
        const a = dates[idx[0]], z = dates[idx[idx.length - 1]];
        chip(`${w + 1}주차 ${md(a)}~${md(z)}`, "", () => {
          const allOn = idx.every((i) => selected.has(ISO[i]));
          idx.forEach((i) => allOn ? selected.delete(ISO[i]) : selected.add(ISO[i]));
          changed();
        });
      }
    }
    chip("주말만", "", () => {
      ISO.forEach((d, i) => { if (dowIdx(dates[i]) >= 5 && !isPast(d)) selected.add(d); });
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
        el.className = "day" + (dowIdx(d) === 6 ? " sun" : "") + (ISO[i] === TODAY_ISO ? " today" : "") + (isPast(ISO[i]) ? " past" : "");
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
      if (isPast(d) || (paint ? selected.has(d) : !selected.has(d))) return;
      paint ? selected.add(d) : selected.delete(d);
      renderPick();
    };
    $("pick-calendar").addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".day[data-iso]");
      if (!el || isPast(el.dataset.iso)) return;
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
      $("pick-count").textContent = `${OPEN.filter((d) => selected.has(d)).length} / ${OPEN.length}일 선택`;
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
      const { error } = await sb.rpc("save_response", { p_room: id, p_name: me, p_pin: myPin, p_dates: sorted });
      if (error) {
        st.textContent = error.message === "wrong pin" ? "PIN이 맞지 않아 저장하지 못했어요" : "저장 실패: " + error.message;
        st.classList.add("err");
        return;
      }
      st.textContent = "저장됨 ✓";
      const mine = all.find((p) => p.name === me);
      if (mine) mine.dates = sorted; else all.push({ name: me, dates: sorted });
      renderSummary();
    }

    // ---------- 데이터 ----------
    async function load() {
      const { data, error } = await sb.rpc("get_room", { p_id: id });
      if (error || !data) { toast("불러오기 실패" + (error ? ": " + error.message : "")); return false; }
      all = data.responses;
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
      // 남은 날짜를 하나도 안 고른 사람은 집계에서 뺀다 (전원 기준이 막히지 않게)
      const act = all.filter((p) => p.dates.some((d) => !isPast(d)));
      const n = act.length;
      const denom = TOTAL || n || 1;
      $("people-count").textContent = TOTAL ? `(${n}/${TOTAL}명 입력)` : `(${n}명 입력)`;

      const focus = act.find((p) => p.name === focusName);
      if (!focus) focusName = null;
      show($("legend"), !focus);
      const fb = $("focus");
      fb.innerHTML = "";
      if (focus) {
        const t = document.createElement("span");
        t.textContent = `${focus.name} 님이 고른 날짜 (${focus.dates.filter((d) => !isPast(d)).length}일)`;
        const b = document.createElement("button");
        b.className = "link";
        b.textContent = "전체 보기";
        b.addEventListener("click", () => { focusName = null; renderSummary(); });
        fb.append(t, b);
      }
      show(fb, !!focus);

      const counts = ISO.map((d) => isPast(d) ? [] : whoOn(d));
      sumCells.forEach((el, i) => {
        const names = counts[i];
        const full = !focus && names.length > 0 && names.length >= denom;
        el.classList.toggle("full", full);
        el.classList.toggle("pick", !!focus && focus.dates.includes(ISO[i]));
        el.classList.toggle("sel", el.dataset.iso === detailIso);
        el.style.background = focus || full || !names.length ? "" : `rgba(var(--heat), ${0.12 + 0.55 * (names.length / denom)})`;
        let extra = el.querySelector(".names");
        if (!extra) {
          extra = document.createElement("div"); extra.className = "names"; el.appendChild(extra);
          const c = document.createElement("div"); c.className = "cnt"; el.appendChild(c);
        }
        extra.textContent = focus ? "" : names.join(", ");
        el.querySelector(".cnt").textContent = !focus && names.length ? `${names.length}/${denom}` : "";
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
            const missing = act.map((p) => p.name).filter((nm) => !counts[x.i].includes(nm));
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
        const no = act.map((p) => p.name).filter((nm) => !yes.includes(nm));
        det.innerHTML = "";
        const h = document.createElement("strong"); h.textContent = fmt(parse(detailIso)); det.appendChild(h);
        const y = document.createElement("div"); y.textContent = `되는 사람 (${yes.length}): ${yes.join(", ") || "-"}`; det.appendChild(y);
        const nn = document.createElement("div"); nn.className = "no"; nn.textContent = `안 되는 사람 (${no.length}): ${no.join(", ") || "-"}`; det.appendChild(nn);
        show(det, true);
      } else show(det, false);

      // 참여자 목록
      const pl = $("people");
      pl.innerHTML = "";
      act.forEach((p) => {
        const s = document.createElement("button");
        s.className = "chip" + (p.name === me ? " me" : "") + (p.name === focusName ? " active" : "");
        s.textContent = `${p.name} · ${p.dates.filter((d) => !isPast(d)).length}일`;
        s.addEventListener("click", () => { focusName = focusName === p.name ? null : p.name; renderSummary(); });
        pl.appendChild(s);
      });
    }

    // ---------- 로그인 ----------
    // 이름+PIN 확인 후 입장. PIN이 틀리면 false
    async function enter(name, pin) {
      const { data: ok, error } = await sb.rpc("check_pin", { p_room: id, p_name: name, p_pin: pin });
      if (error) { toast("확인 실패: " + error.message); return false; }
      if (!ok) return false;
      me = name;
      myPin = pin;
      store.set(nameKey, { name, pin });
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
      return true;
    }

    // 입장 화면: 이미 입력한 사람 목록 + 이름에 맞는 안내
    function renderLogin() {
      const name = $("name-input").value.trim();
      const kl = $("known-list");
      kl.innerHTML = "";
      all.forEach((p) => {
        const b = document.createElement("button");
        b.className = "chip" + (p.name === name ? " active" : "");
        b.textContent = p.name;
        b.addEventListener("click", () => {
          $("name-input").value = p.name;
          renderLogin();
          $("pin-input").focus();
        });
        kl.appendChild(b);
      });
      show($("known"), all.length > 0);
      $("login-hint").textContent = all.some((p) => p.name === name)
        ? "처음 정한 PIN 4자리를 입력하세요."
        : "처음이면 아무 숫자 4자리를 정하세요. 다음에 같은 이름·PIN으로 들어오면 이어서 수정할 수 있어요.";
    }

    $("enter-btn").addEventListener("click", async () => {
      const name = $("name-input").value.trim();
      const pin = $("pin-input").value.trim();
      const st = $("login-status");
      st.textContent = "";
      if (!name) { $("name-input").focus(); return; }
      if (!/^[0-9]{4}$/.test(pin)) { st.textContent = "PIN은 숫자 4자리예요."; $("pin-input").focus(); return; }
      $("enter-btn").disabled = true;
      const ok = await enter(name, pin);
      $("enter-btn").disabled = false;
      if (!ok) st.textContent = "PIN이 맞지 않아요.";
    });
    $("name-input").addEventListener("input", renderLogin);
    $("name-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) $("pin-input").focus(); });
    $("pin-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("enter-btn").click(); });
    $("logout-btn").addEventListener("click", () => {
      me = null;
      myPin = null;
      store.del(nameKey);
      $("name-input").value = "";
      $("pin-input").value = "";
      $("login-status").textContent = "";
      renderLogin();
      renderSummary();
      show($("view-pick"), false);
      show($("view-login"), true);
    });
    $("delete-btn").addEventListener("click", async () => {
      if (!confirm(`'${me}' 응답을 삭제할까요?`)) return;
      clearTimeout(saveTimer);
      const { error } = await sb.rpc("delete_response", { p_room: id, p_name: me, p_pin: myPin });
      if (error) { toast("삭제 실패: " + error.message); return; }
      all = all.filter((p) => p.name !== me);
      $("logout-btn").click();
      renderSummary();
      toast("삭제했어요");
    });
    const reload = async () => { if (!(await load())) return false; renderSummary(); if (!me) renderLogin(); return true; };
    $("refresh-btn").addEventListener("click", async () => { if (await reload()) toast("새로고침했어요"); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reload(); });

    // 이 브라우저에 저장된 이름·PIN이 있으면 자동 입장 (예전 버전은 이름만 저장돼 있어 다시 입력받음)
    const saved = store.get(nameKey, null);
    if (!(saved && saved.pin && await enter(saved.name, saved.pin))) {
      store.del(nameKey);
      show($("view-login"), true);
      show($("view-summary"), true);
      renderLogin();
      renderSummary();
    }
  }
})();
