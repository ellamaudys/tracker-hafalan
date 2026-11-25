// Tracker Hafalan: login, daftar surah, catatan per ayat, murajaah, ekspor.
// Data disimpan di Supabase (tabel "hafalan", lihat supabase/schema.sql).

(function () {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const REVIEW_DAYS = Number(cfg.REVIEW_DAYS) || 14;
  const TOTAL_AYAT = SURAHS.reduce((sum, s) => sum + s[1], 0);
  const $ = (id) => document.getElementById(id);

  let db = null;          // klien Supabase
  let userId = null;
  let loadedFor = null;   // id pengguna yang datanya sudah dimuat
  let session = null;
  let busy = false;

  const state = {
    ready: false,
    data: new Map(),      // nomor surah -> Map(ayat -> { m: tanggal hafal, r: murajaah terakhir })
    selected: null,
    filter: "semua",
    search: "",
    form: { from: "", to: "", date: "" }
  };

  /* ---------------- Utilitas ---------------- */

  function pad(n) { return String(n).padStart(2, "0"); }

  // Tanggal lokal (bukan UTC) supaya tidak meleset sehari di dekat tengah malam.
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function parseDate(s) {
    const p = s.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function daysAgo(s) {
    return Math.round((parseDate(todayStr()) - parseDate(s)) / 86400000);
  }
  function agoText(days) {
    if (days <= 0) return "hari ini";
    if (days === 1) return "kemarin";
    return days + " hari lalu";
  }
  function errText(e) { return e && e.message ? e.message : String(e); }
  function norm(t) { return String(t).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const key in props || {}) {
      const v = props[key];
      if (v === null || v === undefined || v === false) continue;
      if (key === "class") node.className = v;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), v);
      else node.setAttribute(key, v);
    }
    kids.flat().filter((k) => k !== null && k !== undefined && k !== false).forEach((k) => node.append(k));
    return node;
  }

  function progressBar(pct) {
    const fill = el("div", { class: "bar-fill" });
    fill.style.width = pct + "%";
    return el("div", { class: "bar", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
  }

  let msgTimer = null;
  function flash(text, kind) {
    const m = $("msg");
    m.textContent = text;
    m.className = "msg " + (kind || "ok");
    m.hidden = false;
    clearTimeout(msgTimer);
    if (kind !== "error") msgTimer = setTimeout(() => { m.hidden = true; }, 4500);
  }
  function hideMsg() { clearTimeout(msgTimer); $("msg").hidden = true; }

  function show(which) {
    ["setup", "auth", "app"].forEach((id) => { $(id).hidden = id !== which; });
    $("userbox").hidden = which !== "app";
  }

  /* ---------------- Perhitungan ---------------- */

  function surahStats(n) {
    const total = SURAHS[n - 1][1];
    const m = state.data.get(n);
    const count = m ? m.size : 0;
    let oldest = null;
    if (m) for (const v of m.values()) if (oldest === null || v.r < oldest) oldest = v.r;
    const age = oldest === null ? null : daysAgo(oldest);
    return { n, name: SURAHS[n - 1][0], total, count, age, done: count === total, overdue: age !== null && age >= REVIEW_DAYS };
  }

  /* ---------------- Render ---------------- */

  function render() {
    $("loadfail").hidden = state.ready;
    $("appbody").hidden = !state.ready;
    if (!state.ready) return;
    renderSummary();
    renderList();
    renderDetail();
  }

  function tile(big, small, alert) {
    return el("div", { class: "tile" + (alert ? " alert" : "") }, el("strong", {}, big), el("span", {}, small));
  }

  function renderSummary() {
    let ayat = 0, selesai = 0, berjalan = 0, telat = 0;
    for (let n = 1; n <= SURAHS.length; n++) {
      const s = surahStats(n);
      ayat += s.count;
      if (s.done) selesai++; else if (s.count > 0) berjalan++;
      if (s.overdue) telat++;
    }
    const pct = ((ayat / TOTAL_AYAT) * 100).toFixed(1).replace(".", ",");
    $("summary").replaceChildren(
      tile(ayat.toLocaleString("id-ID") + " ayat", "dari " + TOTAL_AYAT.toLocaleString("id-ID") + " (" + pct + "%)"),
      tile(selesai + " surah", "selesai dihafal"),
      tile(berjalan + " surah", "sedang berjalan"),
      tile(telat + " surah", "perlu murajaah (≥ " + REVIEW_DAYS + " hari)", telat > 0)
    );
  }

  function passFilter(s) {
    switch (state.filter) {
      case "berjalan": return s.count > 0 && !s.done;
      case "selesai": return s.done;
      case "murajaah": return s.overdue;
      case "belum": return s.count === 0;
      default: return true;
    }
  }
  function passSearch(s) {
    const q = state.search;
    if (!q) return true;
    return norm(s.name).includes(norm(q)) || String(s.n) === q.trim();
  }

  function listItem(s) {
    const pct = Math.round((s.count / s.total) * 100);
    const status = s.done ? "selesai" : s.count > 0 ? "berjalan" : "belum mulai";
    const active = state.selected === s.n;
    return el("li", {},
      el("button", { class: "surah" + (active ? " active" : "") + (s.overdue ? " stale" : ""), type: "button", "aria-current": active ? "true" : null, onclick: () => select(s.n) },
        el("span", { class: "snum" }, String(s.n)),
        el("span", { class: "sbody" },
          el("span", { class: "sname" }, s.name),
          el("span", { class: "smeta muted" }, s.count + "/" + s.total + " ayat · " + status),
          s.count > 0 ? el("span", { class: "smeta " + (s.overdue ? "warn" : "muted") }, "Murajaah terlama: " + agoText(s.age)) : null,
          progressBar(pct)
        )
      )
    );
  }

  function renderList() {
    const items = [];
    for (let n = 1; n <= SURAHS.length; n++) {
      const s = surahStats(n);
      if (passFilter(s) && passSearch(s)) items.push(listItem(s));
    }
    if (!items.length) items.push(el("li", { class: "muted", style: "padding:16px" }, "Tidak ada surah yang cocok."));
    $("list").replaceChildren(...items);
  }

  function renderDetail() {
    const box = $("detail");
    if (!state.selected) {
      box.replaceChildren(el("p", { class: "muted" }, "Pilih surah dari daftar untuk mencatat hafalan per ayat."));
      return;
    }
    const s = surahStats(state.selected);
    const m = state.data.get(s.n) || new Map();

    const grid = el("div", { class: "ayat-grid" });
    for (let a = 1; a <= s.total; a++) {
      const v = m.get(a);
      let cls = "ayat";
      let title = "Ayat " + a + ": belum hafal";
      if (v) {
        cls += daysAgo(v.r) >= REVIEW_DAYS ? " stale" : " hafal";
        title = "Ayat " + a + ": hafal sejak " + v.m + ", murajaah terakhir " + v.r;
      }
      grid.append(el("button", { class: cls, type: "button", title, "aria-pressed": v ? "true" : "false", onclick: () => run(() => toggleAyat(s.n, a)) }, String(a)));
    }

    const f = state.form;
    const form = el("div", { class: "range-form" },
      el("div", { class: "fields" },
        el("div", {}, el("label", { for: "f-from" }, "Dari ayat"),
          el("input", { id: "f-from", type: "number", min: "1", max: String(s.total), inputmode: "numeric", value: f.from, oninput: (e) => { state.form.from = e.target.value; } })),
        el("div", {}, el("label", { for: "f-to" }, "Sampai ayat"),
          el("input", { id: "f-to", type: "number", min: "1", max: String(s.total), inputmode: "numeric", value: f.to, oninput: (e) => { state.form.to = e.target.value; } })),
        el("div", {}, el("label", { for: "f-date" }, "Tanggal"),
          el("input", { id: "f-date", type: "date", max: todayStr(), value: f.date, oninput: (e) => { state.form.date = e.target.value; } }))
      ),
      el("div", { class: "row" },
        el("button", { class: "btn", type: "button", onclick: () => run(() => formAction("add")) }, "Tandai hafal"),
        el("button", { class: "btn ghost", type: "button", onclick: () => run(() => formAction("review")) }, "Catat murajaah"),
        el("button", { class: "btn ghost", type: "button", onclick: () => { state.form.from = "1"; state.form.to = String(s.total); renderDetail(); } }, "Seluruh surah"),
        el("button", { class: "btn danger", type: "button", onclick: () => run(() => formAction("remove")) }, "Batalkan hafal")
      )
    );

    box.replaceChildren(
      el("h2", {}, s.n + ". " + s.name),
      el("p", { class: "muted" }, s.count + " dari " + s.total + " ayat hafal" + (s.count > 0 ? " · murajaah terlama: " + agoText(s.age) : "")),
      el("div", { class: "legend" },
        el("span", {}, el("i", { class: "l-hafal" }), "hafal"),
        el("span", {}, el("i", { class: "l-stale" }), "hafal, perlu murajaah"),
        el("span", {}, el("i"), "belum hafal")
      ),
      grid,
      el("p", { class: "muted small" }, "Ketuk satu ayat untuk menandai hafal (dengan tanggal di bawah) atau membatalkannya. Untuk banyak ayat sekaligus, isi rentang lalu pilih tindakan."),
      form
    );
  }

  function select(n) {
    state.selected = n;
    state.form = { from: "", to: "", date: todayStr() };
    renderList();
    renderDetail();
    const d = $("detail");
    if (window.matchMedia && window.matchMedia("(max-width: 860px)").matches && d.scrollIntoView) {
      d.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ---------------- Operasi database ---------------- */

  async function run(fn) {
    if (busy) return;
    busy = true;
    document.body.classList.add("busy");
    try { await fn(); }
    catch (e) { flash("Gagal menyimpan: " + errText(e), "error"); }
    finally {
      busy = false;
      document.body.classList.remove("busy");
      render();
    }
  }

  async function loadAll() {
    const size = 1000; // batas bawaan Supabase per permintaan: baca bertahap
    const map = new Map();
    for (let from = 0; ; from += size) {
      const res = await db.from("hafalan")
        .select("surah,ayat,memorized_on,last_reviewed_on")
        .order("surah").order("ayat")
        .range(from, from + size - 1);
      if (res.error) throw res.error;
      for (const r of res.data) {
        let m = map.get(r.surah);
        if (!m) { m = new Map(); map.set(r.surah, m); }
        m.set(r.ayat, { m: r.memorized_on, r: r.last_reviewed_on });
      }
      if (res.data.length < size) break;
    }
    state.data = map;
  }

  async function addRange(n, from, to, date) {
    const m = state.data.get(n) || new Map();
    const rows = [];
    for (let a = from; a <= to; a++) {
      if (!m.has(a)) rows.push({ user_id: userId, surah: n, ayat: a, memorized_on: date, last_reviewed_on: date });
    }
    if (!rows.length) { flash("Semua ayat pada rentang itu sudah tercatat hafal."); return; }
    const res = await db.from("hafalan").upsert(rows, { onConflict: "user_id,surah,ayat", ignoreDuplicates: true });
    if (res.error) throw res.error;
    rows.forEach((r) => m.set(r.ayat, { m: date, r: date }));
    state.data.set(n, m);
    flash(rows.length + " ayat ditandai hafal.");
  }

  async function reviewRange(n, from, to, date) {
    const m = state.data.get(n);
    const targets = [];
    if (m) for (let a = from; a <= to; a++) if (m.has(a)) targets.push(a);
    if (!targets.length) { flash("Tidak ada ayat hafal pada rentang itu."); return; }
    const res = await db.from("hafalan").update({ last_reviewed_on: date })
      .eq("user_id", userId).eq("surah", n).gte("ayat", from).lte("ayat", to);
    if (res.error) throw res.error;
    targets.forEach((a) => { m.get(a).r = date; });
    flash("Murajaah dicatat untuk " + targets.length + " ayat.");
  }

  async function removeRange(n, from, to) {
    const m = state.data.get(n);
    const targets = [];
    if (m) for (let a = from; a <= to; a++) if (m.has(a)) targets.push(a);
    if (!targets.length) { flash("Tidak ada ayat hafal pada rentang itu."); return; }
    const res = await db.from("hafalan").delete()
      .eq("user_id", userId).eq("surah", n).gte("ayat", from).lte("ayat", to);
    if (res.error) throw res.error;
    targets.forEach((a) => m.delete(a));
    if (!m.size) state.data.delete(n);
    flash(targets.length + " ayat dibatalkan dari daftar hafal.");
  }

  async function toggleAyat(n, a) {
    const m = state.data.get(n);
    const name = SURAHS[n - 1][0];
    if (m && m.has(a)) {
      if (!window.confirm("Batalkan hafalan ayat " + a + " surah " + name + "?")) return;
      await removeRange(n, a, a);
    } else {
      await addRange(n, a, a, state.form.date || todayStr());
    }
  }

  async function formAction(kind) {
    const n = state.selected;
    const total = SURAHS[n - 1][1];
    const from = parseInt(state.form.from, 10);
    let to = parseInt(state.form.to, 10);
    if (!from) { flash("Isi nomor ayat awal terlebih dahulu.", "error"); return; }
    if (!to) to = from;
    if (from < 1 || to > total || from > to) { flash("Rentang tidak valid. Surah ini punya ayat 1 sampai " + total + ".", "error"); return; }
    const date = state.form.date;
    if (!date) { flash("Pilih tanggal terlebih dahulu.", "error"); return; }
    if (date > todayStr()) { flash("Tanggal tidak boleh di masa depan.", "error"); return; }
    hideMsg();
    if (kind === "add") await addRange(n, from, to, date);
    else if (kind === "review") await reviewRange(n, from, to, date);
    else {
      if (!window.confirm("Batalkan hafalan ayat " + from + "–" + to + " surah " + SURAHS[n - 1][0] + "?")) return;
      await removeRange(n, from, to);
    }
  }

  function exportJson() {
    const rows = [];
    for (let n = 1; n <= SURAHS.length; n++) {
      const m = state.data.get(n);
      if (!m) continue;
      [...m.keys()].sort((x, y) => x - y).forEach((a) => {
        const v = m.get(a);
        rows.push({ surah: n, nama_surah: SURAHS[n - 1][0], ayat: a, tanggal_hafal: v.m, murajaah_terakhir: v.r });
      });
    }
    const body = JSON.stringify({ diekspor_pada: todayStr(), jumlah_ayat: rows.length, data: rows }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = el("a", { href: url, download: "hafalan-" + todayStr() + ".json" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------- Login dan sesi ---------------- */

  async function startLoad() {
    state.ready = false;
    $("loadtext").textContent = "Memuat data…";
    $("btn-retry").hidden = true;
    render();
    try {
      await loadAll();
      state.ready = true;
    } catch (e) {
      $("loadtext").textContent = "Data gagal dimuat: " + errText(e);
      $("btn-retry").hidden = false;
    }
    render();
  }

  async function route(sess) {
    session = sess;
    const uid = sess && sess.user ? sess.user.id : null;
    if (!uid) {
      userId = null; loadedFor = null;
      state.data = new Map(); state.selected = null; state.ready = false;
      show("auth");
      return;
    }
    userId = uid;
    $("useremail").textContent = sess.user.email || "";
    if (loadedFor === uid) return; // token diperbarui saja, tidak perlu muat ulang
    loadedFor = uid;
    state.selected = null;
    state.form = { from: "", to: "", date: todayStr() };
    show("app");
    await startLoad();
  }

  async function login() {
    hideMsg();
    const res = await db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    if (res.error) flash("Gagal masuk: " + errText(res.error), "error");
  }

  async function signup() {
    hideMsg();
    const email = $("email").value.trim();
    const password = $("password").value;
    if (!email || password.length < 6) { flash("Isi email dan kata sandi (minimal 6 karakter) dulu.", "error"); return; }
    const res = await db.auth.signUp({ email, password });
    if (res.error) { flash("Gagal mendaftar: " + errText(res.error), "error"); return; }
    if (!res.data.session) flash("Pendaftaran berhasil. Cek email Anda untuk konfirmasi, lalu masuk.");
  }

  async function init() {
    const missing = (v) => !v || /^ISI_/.test(v);
    if (missing(cfg.SUPABASE_URL) || missing(cfg.SUPABASE_KEY)) { show("setup"); return; }
    if (!window.supabase || !window.supabase.createClient) {
      show("setup");
      flash("Pustaka Supabase gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.", "error");
      return;
    }
    db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

    $("auth-form").addEventListener("submit", (e) => { e.preventDefault(); login(); });
    $("btn-signup").addEventListener("click", signup);
    $("btn-logout").addEventListener("click", () => db.auth.signOut());
    $("btn-export").addEventListener("click", exportJson);
    $("btn-retry").addEventListener("click", startLoad);
    $("search").addEventListener("input", (e) => { state.search = e.target.value; renderList(); });
    $("filter").addEventListener("change", (e) => { state.filter = e.target.value; renderList(); });

    // Jangan memanggil database langsung di dalam callback ini (aturan Supabase): tunda dengan setTimeout.
    db.auth.onAuthStateChange((_event, sess) => { setTimeout(() => route(sess), 0); });

    const res = await db.auth.getSession();
    await route(res.data ? res.data.session : null);
  }

  init();
})();
