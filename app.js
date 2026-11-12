/* お茶会 会費集金：画面と操作。
   データの保存先とサインインは firebase.js が「アダプター」として渡す。
   名簿や金額はこのファイルには含めない（すべて Firestore から読む）。 */
window.ShukinApp = (() => {
  "use strict";
  const $ = (s, root = document) => root.querySelector(s);
  const yen = n => (Number(n) || 0).toLocaleString("ja-JP");
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動く */ } }
  };
  const ST_LABEL = { paid: "受取済", partial: "一部受取", unpaid: "未収", none: "集金なし" };
  const PATH_OK = /^(config\/app|periods\/[A-Za-z0-9_-]+(\/charges\/[A-Za-z0-9_-]+)?|log\/[A-Za-z0-9_-]+)$/;

  const S = {
    A: null, started: false, me: null,
    config: null, periods: [], periodsReady: false, pid: null,
    charges: [], chargesReady: false, log: [],
    filter: LS.get("shukin.filter", "all"), q: "",
    openId: null, openPid: null, editPaid: false, confirmCancel: false, formErr: "",
    receiver: LS.get("shukin.receiver", ""),
    pending: new Set(), unsub: {}, lastStamp: null,
    gate: "loading", gateMsg: "", gateInfo: "", importDocs: null, importing: false, importDone: 0, loadTimer: null
  };

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kids.flat()) {
      if (k == null || k === false) continue;
      e.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return e;
  }
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const md = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? `${+m[2]}/${+m[3]}` : (s || ""); };
  const hm = iso => { const d = new Date(iso); if (isNaN(d)) return ""; return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const plain = s => String(s || "").replace(/[\s　]/g, "");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const who = () => ({ uid: S.me ? S.me.uid : null, name: S.me ? (S.me.name || S.me.email || "") : "" });

  const kanjiList = () => (S.config && Array.isArray(S.config.collectors)) ? S.config.collectors : [];
  const kanjiName = k => { if (!k) return ""; const f = kanjiList().find(x => x.key === k); return f ? f.name : k; };
  const curPeriod = () => S.periods.find(p => p.id === S.pid) || null;
  function itemsOf() {
    const p = curPeriod();
    const its = (p && Array.isArray(p.items) && p.items.length) ? p.items.map(i => ({ key: i.key, label: i.label || i.key, short: i.short || i.label || i.key })) : [{ key: "kaihi", label: "会費", short: "会費" }];
    const known = new Set(its.map(i => i.key));
    for (const c of S.charges) for (const k of Object.keys(c.amounts || {})) if (!known.has(k)) { known.add(k); its.push({ key: k, label: k, short: k }); }
    return its;
  }
  function calc(c) {
    let due = 0;
    for (const it of itemsOf()) due += Number(c.amounts && c.amounts[it.key]) || 0;
    const rec = c.paid ? (Number(c.paid.amount) || 0) : 0;
    let st;
    if (rec > 0 && rec >= due) st = "paid";
    else if (rec > 0) st = "partial";
    else if (due > 0) st = "unpaid";
    else st = "none";
    return { due, rec, left: Math.max(due - rec, 0), over: Math.max(rec - due, 0), st };
  }

  /* ---------- 入口（サインイン・権限・取り込み） ---------- */
  function setBanner(kind, text) {
    const b = $("#banner");
    if (!text) { b.hidden = true; b.textContent = ""; b.dataset.kind = ""; return; }
    b.className = "banner " + kind; b.dataset.kind = kind; b.textContent = text; b.hidden = false;
  }
  function showGate(kind, msg) {
    // 同じ入口を出し直すときは、出ているエラー表示や選んだファイルを消さない
    if (S.gate !== kind) { S.gateMsg = msg || ""; S.gateInfo = ""; }
    else if (msg) S.gateMsg = msg;
    S.gate = kind;
    $("#appView").hidden = true;
    $("#periodTabs").replaceChildren();
    if (S.openId) closeSheet();
    renderGate();
  }
  function showApp() {
    if (S.gate === "app") return;
    S.gate = "app";
    $("#gate").hidden = true; $("#gate").replaceChildren();
    $("#appView").hidden = false;
  }
  function renderAcct() {
    const a = $("#acct");
    if (!S.me) { a.hidden = true; return; }
    $("#acctName").textContent = S.me.name || S.me.email || "";
    $("#acctName").title = S.me.email || "";
    a.hidden = false;
  }
  function renderGate() {
    const g = $("#gate");
    g.hidden = false;
    const k = S.gate;
    let kids;
    if (k === "loading") {
      kids = [el("h2", {}, "読み込んでいます…"), el("p", {}, "しばらくお待ちください。")];
    } else if (k === "config") {
      kids = [el("h2", {}, "Firebase の設定がまだです"),
        el("p", {}, "firebase-config.js に Firebase の設定値を書くと使えるようになります。手順は README を見てください。")];
    } else if (k === "loadfail") {
      kids = [el("h2", {}, "部品を読み込めませんでした"),
        el("p", {}, "通信状態を確かめて、ページを開き直してください。"),
        S.gateMsg ? el("p", { class: "small" }, S.gateMsg) : null];
    } else if (k === "signin") {
      kids = [el("h2", {}, "幹事の Google アカウントでサインインしてください"),
        el("p", {}, "このページは登録された幹事だけが使えます。"),
        el("button", { type: "button", class: "btn primary", onclick: doSignIn }, "Google でサインイン"),
        S.gateMsg ? el("p", { class: "ferr", role: "alert" }, S.gateMsg) : null,
        el("p", { class: "small" }, "LINE などのアプリの中で開いた画面ではサインインできません。Safari か Chrome で開いてください。")];
    } else if (k === "denied") {
      kids = [el("h2", {}, "このアカウントでは開けません"),
        el("p", {}, "サインイン中のアカウント："),
        el("p", { class: "mail" }, (S.me && S.me.email) || "（メールアドレス不明）"),
        el("p", {}, "会計担当に、このメールアドレスを幹事の一覧に登録してもらってください。別のアカウントで入り直すときは、右上のサインアウトから。")];
    } else if (k === "import") {
      const docs = S.importDocs;
      const sumBox = docs ? (() => {
        const nP = docs.filter(d => /^periods\/[^/]+$/.test(d.path)).length;
        const nC = docs.filter(d => /\/charges\//.test(d.path)).length;
        const nL = docs.filter(d => /^log\//.test(d.path)).length;
        return el("div", { class: "sum" }, `期 ${nP} 件・名簿と請求 ${nC} 件・履歴 ${nL} 件を取り込みます。`);
      })() : null;
      kids = [el("h2", {}, "まだデータがありません"),
        el("p", {}, "最初の名簿と請求額（JSON ファイル）を取り込みます。会計担当が一度だけ行います。"),
        el("label", { class: "field" }, el("span", { class: "flabel" }, "取り込むファイル"),
          el("input", { id: "importFile", type: "file", accept: ".json,application/json", onchange: onImportFile })),
        sumBox,
        docs ? el("button", { type: "button", class: "btn primary", disabled: S.importing, onclick: doImport }, S.importing ? `取り込んでいます… ${S.importDone || 0} / ${docs.length}` : "取り込む") : null,
        S.gateInfo ? el("p", { class: "hint", role: "status" }, S.gateInfo) : null,
        S.gateMsg ? el("p", { class: "ferr", role: "alert" }, S.gateMsg) : null];
    } else {
      kids = [el("h2", {}, "表示できません")];
    }
    g.replaceChildren(...kids.filter(Boolean));
  }

  function doSignIn() {
    if (!S.A) return;
    S.gateMsg = "";
    let p;
    try { p = S.A.signIn(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).catch(e => {
      const c = (e && e.code) || "";
      if (c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request") return;
      const m = {
        "auth/popup-blocked": "サインイン画面が止められました。ブラウザでこのページのポップアップを許可してから、もう一度押してください。",
        "auth/unauthorized-domain": "このページのアドレスが Firebase の承認済みドメインに入っていません（README の手順 4）。",
        "auth/operation-not-allowed": "Firebase で Google ログインが有効になっていません（README の手順 3）。",
        "auth/network-request-failed": "通信できませんでした。電波の良いところで、もう一度押してください。"
      }[c] || `サインインできませんでした（${c || "不明なエラー"}）。`;
      S.gateMsg = m;
      if (S.gate === "signin") renderGate();
    });
  }

  function onImportFile(ev) {
    const f = ev.target.files && ev.target.files[0];
    S.importDocs = null; S.gateMsg = "";
    if (!f) { renderGate(); return; }
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const obj = JSON.parse(String(rd.result).replace(/^﻿/, ""));
        if (!obj || obj.format !== "ochakai-shukin" || !Array.isArray(obj.docs)) throw new Error("形式が違います");
        const bad = obj.docs.find(d => !d || typeof d.path !== "string" || !PATH_OK.test(d.path) || !d.data || typeof d.data !== "object" || Array.isArray(d.data));
        if (bad) throw new Error("取り込めない行があります：" + (bad && bad.path));
        if (!obj.docs.some(d => /^periods\/[^/]+$/.test(d.path))) throw new Error("期の情報が入っていません");
        S.importDocs = obj.docs;
      } catch (e) {
        S.gateMsg = "このファイルは取り込めません。" + (e && e.message ? e.message : "");
      }
      renderGate();
    };
    rd.onerror = () => { S.gateMsg = "ファイルを読めませんでした。"; renderGate(); };
    rd.readAsText(f, "utf-8");
  }
  async function doImport() {
    if (!S.importDocs || S.importing) return;
    S.importing = true; S.importDone = 0; S.gateMsg = ""; S.gateInfo = ""; renderGate();
    try {
      await S.A.importDocs(S.importDocs, n => { S.importDone = n; if (S.gate === "import") renderGate(); });
      S.importDocs = null;
      S.gateInfo = "取り込みました。名簿を読み込んでいます…";
      toast("取り込みました");
    } catch (e) {
      console.error("import failed", e);
      S.gateMsg = (e && e.code === "permission-denied") ? "取り込む権限がありません。幹事の一覧にこのアカウントが入っているか確かめてください。" : `取り込めませんでした（${(e && e.code) || "不明"}）。`;
      if (S.importDone) S.gateMsg += `（${S.importDone} 件までは書き込み済みです。もう一度「取り込む」を押すと続きから上書きします）`;
    } finally {
      S.importing = false;
      if (S.gate === "import") renderGate();
    }
  }

  /* ---------- 表示 ---------- */
  function renderHeader() {
    const nav = $("#periodTabs");
    if (S.gate !== "app") { nav.replaceChildren(); return; }
    nav.replaceChildren(...S.periods.map(p => el("button", {
      type: "button", class: "ptab" + (p.id === S.pid ? " on" : ""), "aria-pressed": String(p.id === S.pid),
      onclick: () => { if (p.id !== S.pid) setPeriod(p.id); }
    }, p.label || p.id)));
    const p = curPeriod();
    $("#periodMemo").textContent = (p && p.memo) ? p.memo : "手渡しで受け取った会費・宴会費の記録";
    const t = (S.config && S.config.title) || "お茶会 会費集金";
    $("#appTitle").textContent = t;
    document.title = t;
  }

  function renderSummary() {
    const its = itemsOf();
    let due = 0, rec = 0, left = 0, nDue = 0, nPaid = 0;
    const perItem = Object.fromEntries(its.map(i => [i.key, { plan: 0, got: 0 }]));
    const perKanji = new Map();
    for (const c of S.charges) {
      const r = calc(c);
      due += r.due; rec += r.rec; left += r.left;
      if (r.due > 0) { nDue++; if (r.st === "paid") nPaid++; }
      let rest = r.rec;
      for (const it of its) {
        const a = Number(c.amounts && c.amounts[it.key]) || 0;
        perItem[it.key].plan += a;
        const g = Math.min(a, Math.max(rest, 0)); perItem[it.key].got += g; rest -= g;
      }
      if (r.rec > 0) { const k = (c.paid && c.paid.receiver) || ""; perKanji.set(k, (perKanji.get(k) || 0) + r.rec); }
    }
    const ready = S.charges.length > 0;
    $("#sumPaid").textContent = ready ? yen(rec) : "—";
    $("#sumDue").textContent = ready ? yen(due) : "—";
    $("#sumLeft").textContent = ready ? yen(left) : "—";
    $("#cntPaid").textContent = ready ? nPaid : "—";
    $("#cntDue").textContent = ready ? nDue : "—";
    $("#barFill").style.width = (due > 0 ? Math.min(100, rec / due * 100) : 0) + "%";

    $("#itemTable").replaceChildren(el("caption", {}, "項目ごと（円）"),
      el("thead", {}, el("tr", {}, el("th", {}, "項目"), el("th", {}, "予定"), el("th", {}, "受取"), el("th", {}, "未収"))),
      el("tbody", {}, its.map(i => el("tr", {}, el("td", {}, i.label), el("td", { class: "num" }, yen(perItem[i.key].plan)), el("td", { class: "num" }, yen(perItem[i.key].got)), el("td", { class: "num" }, yen(perItem[i.key].plan - perItem[i.key].got)))),
        el("tr", {}, el("th", {}, "合計"), el("th", { class: "num" }, yen(due)), el("th", { class: "num" }, yen(Math.min(rec, due))), el("th", { class: "num" }, yen(left)))));
    const keys = [...kanjiList().map(k => k.key), ...[...perKanji.keys()].filter(k => !kanjiList().some(x => x.key === k))];
    const trs = keys.filter(k => k !== "" || perKanji.has("")).map(k => el("tr", {}, el("td", {}, k ? kanjiName(k) : "幹事の記録なし"), el("td", { class: "num" }, yen(perKanji.get(k) || 0))));
    $("#kanjiTable").replaceChildren(el("caption", {}, "受け取った幹事ごと（円）"),
      el("thead", {}, el("tr", {}, el("th", {}, "幹事"), el("th", {}, "受取額"))),
      el("tbody", {}, trs, el("tr", {}, el("th", {}, "合計"), el("th", { class: "num" }, yen(rec)))));
  }

  function chipsFor(c) {
    const out = [];
    for (const it of itemsOf()) {
      const a = Number(c.amounts && c.amounts[it.key]) || 0;
      const att = c.attend ? c.attend[it.key] : undefined;
      if (a > 0) out.push(el("span", { class: "chip due" }, `${it.short} ${yen(a)}`));
      else if (att === "×") out.push(el("span", { class: "chip abs" }, `${it.short} 欠席`));
      else if (att === "" && !/退職|休職/.test(c.note || "")) out.push(el("span", { class: "chip abs" }, `${it.short} 未回答`));
    }
    if (c.note) out.push(el("span", { class: "chip note" }, c.note));
    return out;
  }

  function renderList() {
    const box = $("#list");
    for (const b of document.querySelectorAll("#filterSeg button")) b.setAttribute("aria-pressed", String(b.dataset.f === S.filter));
    if (!S.charges.length) {
      box.replaceChildren(el("div", { class: "empty" }, S.chargesReady
        ? [el("b", {}, "この期の名簿はまだありません"), "会計担当が名簿と請求額を登録すると表示されます。"]
        : [el("b", {}, "名簿を読み込んでいます…"), "部員ごとの請求額と受取の記録がここに並びます。"]));
      return;
    }
    const q = plain(S.q);
    const groups = [];
    const byG = new Map();
    for (const c of S.charges) {
      const g = c.group || "その他";
      if (!byG.has(g)) { byG.set(g, []); groups.push(g); }
      byG.get(g).push(c);
    }
    const sections = [];
    for (const g of groups) {
      const all = byG.get(g).map(c => ({ c, r: calc(c) }));
      const nDue = all.filter(x => x.r.due > 0).length, nPaid = all.filter(x => x.r.due > 0 && x.r.st === "paid").length;
      const shown = all.filter(({ c, r }) => {
        if (q && !plain(c.name).includes(q)) return false;
        if (S.filter === "unpaid") return r.st === "unpaid" || r.st === "partial";
        if (S.filter === "paid") return r.st === "paid" || r.st === "partial";
        return true;
      });
      if (!shown.length) continue;
      sections.push(el("section", { class: "group" },
        el("h2", {}, g, el("span", {}, nDue ? `受取 ${nPaid} / ${nDue} 人` : "集金なし")),
        el("div", { class: "rows" }, shown.map(({ c, r }) => rowFor(c, r)))));
    }
    if (!sections.length) {
      const msg = S.filter === "unpaid" && !q
        ? [el("b", {}, "未収の人はいません"), "この期の集金対象の全員分を記録済みです。"]
        : [el("b", {}, "該当する人はいません"), "絞り込みや名前の入力を変えてください。"];
      box.replaceChildren(el("div", { class: "empty" }, msg));
      return;
    }
    box.replaceChildren(...sections);
    S.lastStamp = null;
  }

  function rowFor(c, r) {
    const wait = c.__pending ? el("span", { class: "wait" }, "送信待ち") : null;
    let amt;
    if (r.st === "paid") amt = el("div", { class: "amt paid" }, el("span", { class: "v num" }, yen(r.rec)), el("span", { class: "s" }, `受取 ${md(c.paid && c.paid.date)}`), wait);
    else if (r.st === "partial") amt = el("div", { class: "amt unpaid" }, el("span", { class: "v num" }, yen(r.left)), el("span", { class: "s" }, "残り"), wait);
    else if (r.st === "unpaid") amt = el("div", { class: "amt unpaid" }, el("span", { class: "v num" }, yen(r.due)), el("span", { class: "s" }, "未収"), wait);
    else amt = el("div", { class: "amt" }, el("span", { class: "v num" }, "—"), el("span", { class: "s" }, "集金なし"), wait);
    const stamp = r.st === "paid" ? el("span", { class: "stamp" + (S.lastStamp === c.id ? " pop" : ""), "aria-label": "受取済" }, "済")
      : r.st === "partial" ? el("span", { class: "stamp part", "aria-label": "一部受取" }, "一部") : el("span", { "aria-hidden": "true" });
    return el("button", { type: "button", class: "row " + r.st, "data-id": c.id, onclick: () => openSheet(c.id) },
      el("div", { class: "who" }, el("b", {}, el("span", { class: "no num" }, c.no != null ? String(c.no) : ""), c.name || c.id), el("div", { class: "chips" }, chipsFor(c))),
      amt, stamp);
  }

  function renderLog() {
    const ol = $("#logList");
    const items = S.log.slice(0, 80);
    if (!items.length) {
      ol.replaceChildren(el("li", {}, el("span"), el("span", {}, "まだ記録はありません。部員の行をタップして受取を記録すると、ここに残ります。")));
      return;
    }
    ol.replaceChildren(...items.map(x => {
      const parts = [];
      if (x.amount) parts.push(`${yen(x.amount)}円`);
      if (x.receiver) parts.push(`受取 ${kanjiName(x.receiver)}`);
      if (x.date) parts.push(md(x.date));
      return el("li", {},
        el("time", { datetime: x.at || "" }, hm(x.at)),
        el("span", {}, el("span", { class: "act" + (/取消|元に戻す/.test(x.action) ? " undo" : "") }, x.action || ""), "　", x.name || "", parts.length ? `　${parts.join(" · ")}` : ""),
        x.byName ? el("span", { class: "by" }, `記録した人：${x.byName}`) : null);
    }));
  }

  function renderAll() {
    if (S.gate !== "app") return;
    renderHeader(); renderSummary(); renderList();
    if (S.openId) renderSheet();
  }

  /* ---------- 記録シート ---------- */
  function openSheet(id) {
    S.openId = id; S.openPid = S.pid; S.editPaid = false; S.confirmCancel = false; S.formErr = "";
    $("#scrim").hidden = false; $("#sheet").hidden = false;
    renderSheet();
    const f = $("#sheet .x"); if (f) f.focus();
  }
  function closeSheet() {
    const id = S.openId;
    S.openId = null; $("#sheet").hidden = true; $("#scrim").hidden = true; $("#sheet").replaceChildren();
    if (id) { const r = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`); if (r) r.focus(); }
  }
  const openCharge = () => (S.openPid === S.pid) ? S.charges.find(c => c.id === S.openId) : null;

  function renderSheet() {
    const sh = $("#sheet");
    const c = openCharge();
    if (!c) { closeSheet(); return; }
    const keep = {};
    for (const id of ["fAmt", "fDate", "fMemo", "bNote", ...itemsOf().map(i => "b_" + i.key)]) { const n = document.getElementById(id); if (n) keep[id] = n.value; }
    const rv = sh.querySelector('input[name="recv"]:checked'); if (rv) keep.recv = rv.value;
    const focusId = document.activeElement && sh.contains(document.activeElement) ? document.activeElement.id : "";
    const editOpen = !!(sh.querySelector("details.edit") && sh.querySelector("details.edit").open);

    const r = calc(c), its = itemsOf(), p = curPeriod();
    const busy = S.pending.has(c.id);
    const kids = [];
    kids.push(el("div", { class: "sh-head" },
      el("div", {}, el("p", {}, `${p ? p.label : ""}　${c.group || ""}${c.no != null ? " No." + c.no : ""}`), el("h2", { id: "shName" }, c.name || c.id)),
      el("button", { type: "button", class: "x", "aria-label": "閉じる", onclick: closeSheet }, "×")));

    const bill = el("div", { class: "bill" });
    for (const it of its) {
      const a = Number(c.amounts && c.amounts[it.key]) || 0;
      const att = c.attend ? c.attend[it.key] : undefined;
      const sub = att === "○" ? "出席" : att === "×" ? "欠席" : att === "" ? "未回答" : "";
      bill.append(el("div", { class: "li" }, el("span", {}, it.label, sub ? el("small", {}, sub) : null), el("span", { class: "num" }, a ? `${yen(a)}円` : "—")));
    }
    bill.append(el("div", { class: "li tot" }, el("span", {}, "請求額"), el("span", { class: "num" }, `${yen(r.due)}円`)));
    if (c.note) bill.append(el("div", { class: "memo" }, c.note));
    kids.push(bill);

    if (r.rec > 0) {
      const pd = c.paid || {};
      kids.push(el("div", { class: "paidbox" },
        el("span", { class: "stamp big" + (r.st === "partial" ? " part" : ""), "aria-hidden": "true" }, r.st === "partial" ? "一部" : "済"),
        el("div", {},
          el("b", { class: "num" }, `${yen(r.rec)}円 受取済`),
          el("p", {}, [md(pd.date), pd.receiver ? `受取 ${kanjiName(pd.receiver)}` : "受け取った幹事の記録なし"].filter(Boolean).join(" · ")),
          r.st === "partial" ? el("p", {}, `残り ${yen(r.left)}円`) : null,
          r.over > 0 ? el("p", {}, `請求額より ${yen(r.over)}円 多く受け取っています`) : null,
          pd.memo ? el("p", {}, `メモ：${pd.memo}`) : null,
          el("p", { class: "by" }, c.recordedAt ? `記録 ${c.recordedByName ? c.recordedByName + "　" : ""}${hm(c.recordedAt)}` : "以前の記録から取り込み"))));
      if (S.confirmCancel) {
        kids.push(el("div", { class: "confirm" },
          el("span", {}, `${c.name} さんの受取記録を消して、未収に戻します。`),
          el("div", { class: "rowbtns" },
            el("button", { type: "button", class: "btn danger solid", disabled: busy, onclick: cancelPayment }, "受取を取り消す"),
            el("button", { type: "button", class: "btn", onclick: () => { S.confirmCancel = false; renderSheet(); } }, "やめる"))));
      } else if (!S.editPaid) {
        kids.push(el("div", { class: "rowbtns" },
          el("button", { type: "button", class: "btn", onclick: () => { S.editPaid = true; S.formErr = ""; renderSheet(); } }, r.st === "partial" ? "残りを受け取る・直す" : "記録を直す"),
          el("button", { type: "button", class: "btn danger", onclick: () => { S.confirmCancel = true; renderSheet(); } }, "受取を取り消す")));
      }
    }

    const showForm = (r.rec === 0 && r.due > 0) || S.editPaid;
    if (showForm) {
      const pd = c.paid || {};
      const defAmt = S.editPaid ? (r.st === "partial" ? r.due : r.rec) : r.due;
      const defDate = S.editPaid && pd.date && r.st !== "partial" ? pd.date : today();
      const recv = keep.recv != null ? keep.recv : (S.editPaid && pd.receiver ? pd.receiver : S.receiver);
      const amtIn = el("input", { id: "fAmt", type: "number", inputmode: "numeric", min: "0", step: "100", value: keep.fAmt != null ? keep.fAmt : String(defAmt) });
      const dateIn = el("input", { id: "fDate", type: "date", value: keep.fDate != null ? keep.fDate : defDate });
      const memoIn = el("input", { id: "fMemo", type: "text", maxlength: "200", placeholder: "例：お釣り 1,000円渡した", value: keep.fMemo != null ? keep.fMemo : (S.editPaid ? (pd.memo || "") : "") });
      const save = el("button", { type: "submit", class: "btn primary", disabled: busy }, "");
      const label = () => {
        const v = parseInt(amtIn.value, 10);
        save.textContent = busy ? "記録しています…"
          : !S.editPaid ? `${yen(v || 0)}円 受け取った`
          : r.st === "partial" ? `受取額の合計を ${yen(v || 0)}円 にする`
          : `受取額を ${yen(v || 0)}円 に直す`;
      };
      amtIn.addEventListener("input", label); label();
      const list = kanjiList();
      const chips = list.length
        ? el("div", { class: "who-chips" }, list.map(k => el("label", {},
            el("input", { type: "radio", name: "recv", value: k.key, "aria-label": k.name, checked: recv === k.key, onchange: () => { if (!S.editPaid) { S.receiver = k.key; LS.set("shukin.receiver", k.key); } } }),
            el("span", {}, k.name))))
        : el("p", { class: "hint" }, "幹事の一覧が登録されていません。会計担当に頼んでください。");
      kids.push(el("form", { class: "rec", novalidate: true, onsubmit: ev => { ev.preventDefault(); savePayment(); } },
        el("fieldset", {}, el("legend", {}, "受け取った幹事"), chips),
        el("div", { class: "fgrid" },
          el("label", { class: "field" }, el("span", { class: "flabel" }, "受取額（円）"), amtIn),
          el("label", { class: "field" }, el("span", { class: "flabel" }, "受取日"), dateIn)),
        el("label", { class: "field" }, el("span", { class: "flabel" }, "メモ（任意）"), memoIn),
        S.editPaid && r.st === "partial" ? el("p", { class: "hint" }, "これまでに受け取った分と合わせた合計額を入れてください。") : null,
        S.formErr ? el("p", { class: "ferr", role: "alert" }, S.formErr) : null,
        save,
        S.editPaid ? el("button", { type: "button", class: "btn", onclick: () => { S.editPaid = false; S.formErr = ""; renderSheet(); } }, "直さずに戻る") : null));
    } else if (r.due === 0 && r.rec === 0) {
      kids.push(el("p", { class: "hint" }, "この期は集金なしです。集金することになったら、下の「請求額を直す」で金額を入れてください。"));
    }

    const edit = el("details", { class: "edit" }, el("summary", {}, "請求額を直す（出欠の変更など）"),
      el("div", { class: "fgrid" },
        its.map(it => el("label", { class: "field" }, el("span", { class: "flabel" }, `${it.label}（円）`),
          el("input", { id: "b_" + it.key, type: "number", inputmode: "numeric", min: "0", step: "100", value: keep["b_" + it.key] != null ? keep["b_" + it.key] : String(Number(c.amounts && c.amounts[it.key]) || 0) }))),
        el("label", { class: "field" }, el("span", { class: "flabel" }, "備考"), el("input", { id: "bNote", type: "text", maxlength: "100", value: keep.bNote != null ? keep.bNote : (c.note || "") }))),
      el("div", { class: "rowbtns", style: "margin-top:10px" }, el("button", { type: "button", class: "btn", disabled: busy, onclick: saveBill }, "請求額を保存")));
    if (editOpen) edit.open = true;
    kids.push(edit);
    sh.replaceChildren(...kids);
    if (focusId) { const f = document.getElementById(focusId); if (f) f.focus({ preventScroll: true }); }
  }

  /* ---------- 書き込み ---------- */
  // 通信が遅いときは 5 秒で画面を先に進め、送信は裏で続ける（"queued" を返す）
  async function writeCharge(pid, id, data) {
    if (!S.A) throw { code: "unavailable" };
    if (S.pending.has(id)) throw { code: "busy" };
    S.pending.add(id);
    if (S.openId === id) renderSheet();
    const p = S.A.update(`periods/${pid}/charges/${id}`, data);
    try {
      const res = await Promise.race([p.then(() => "ok"), sleep(5000).then(() => "slow")]);
      if (res === "slow") { p.catch(e => toast(failMsg(e))); return "queued"; }
      return "ok";
    } finally {
      S.pending.delete(id);
      if (S.openId === id) renderSheet();
    }
  }
  function addLog(pid, entry) {
    if (!S.A) return;
    const w = who();
    Promise.resolve(S.A.add("log", Object.assign({ period: pid, by: w.uid, byName: w.name, at: new Date().toISOString() }, entry))).catch(() => { /* 履歴は失敗しても記録本体は残る */ });
  }
  function failMsg(e) {
    const code = e && e.code;
    if (code === "permission-denied") return "記録する権限がありません。幹事の一覧にこのアカウントが入っているか確かめてください";
    if (code === "busy") return "前の記録を保存中です。少し待ってからもう一度押してください";
    if (code === "not-found") return "この人のデータが見つかりません。ページを開き直してください";
    return "記録できませんでした。通信状態を確かめて、もう一度押してください";
  }
  const snapPrev = c => ({
    paid: c.paid ? Object.assign({ amount: 0, date: "", receiver: "", memo: "" }, c.paid) : null,
    recordedAt: c.recordedAt || null, recordedBy: c.recordedBy || null, recordedByName: c.recordedByName || null
  });
  const queuedMsg = name => `${name} さんの記録は送信待ちです。つながると自動で送ります。ページは開いたままにしてください`;

  async function savePayment() {
    const c = openCharge(); if (!c) return;
    const pid = S.openPid;
    const amt = parseInt(($("#fAmt") || {}).value, 10);
    const recvEl = document.querySelector('#sheet input[name="recv"]:checked');
    const recv = recvEl ? recvEl.value : "";
    const date = ($("#fDate") || {}).value || today();
    const memo = String(($("#fMemo") || {}).value || "").trim().slice(0, 200);
    if (!recv) { S.formErr = "受け取った幹事を選んでください。"; renderSheet(); return; }
    if (!(amt > 0)) { S.formErr = "受取額を 1円以上で入れてください。"; renderSheet(); return; }
    S.formErr = "";
    const prev = snapPrev(c);
    const action = c.paid ? "受取を修正" : "受取";
    const w = who();
    let res;
    try {
      res = await writeCharge(pid, c.id, { paid: { amount: amt, date, receiver: recv, memo }, recordedAt: new Date().toISOString(), recordedBy: w.uid, recordedByName: w.name });
    } catch (e) { S.formErr = failMsg(e) + "。"; if (S.openId) renderSheet(); return; }
    addLog(pid, { member: c.id, name: c.name, action, amount: amt, receiver: recv, date });
    S.lastStamp = c.id;
    closeSheet();
    renderList();
    toast(res === "queued" ? queuedMsg(c.name) : `${c.name} さん ${yen(amt)}円 を記録しました`, async () => {
      try {
        await writeCharge(pid, c.id, prev);
        addLog(pid, { member: c.id, name: c.name, action: "元に戻す", amount: prev.paid ? prev.paid.amount : 0, receiver: prev.paid ? prev.paid.receiver : "", date: prev.paid ? prev.paid.date : "" });
        toast("記録を元に戻しました");
      } catch (e) { toast(failMsg(e)); }
    });
  }

  async function cancelPayment() {
    const c = openCharge(); if (!c) return;
    const pid = S.openPid;
    const prev = snapPrev(c);
    const w = who();
    let res;
    try {
      res = await writeCharge(pid, c.id, { paid: null, recordedAt: new Date().toISOString(), recordedBy: w.uid, recordedByName: w.name });
    } catch (e) { toast(failMsg(e)); return; }
    addLog(pid, { member: c.id, name: c.name, action: "受取を取消", amount: prev.paid ? prev.paid.amount : 0, receiver: prev.paid ? prev.paid.receiver : "", date: prev.paid ? prev.paid.date : "" });
    closeSheet();
    toast(res === "queued" ? queuedMsg(c.name) : `${c.name} さんの受取記録を取り消しました`, async () => {
      try {
        await writeCharge(pid, c.id, prev);
        addLog(pid, { member: c.id, name: c.name, action: "元に戻す", amount: prev.paid ? prev.paid.amount : 0, receiver: prev.paid ? prev.paid.receiver : "", date: prev.paid ? prev.paid.date : "" });
        toast("記録を元に戻しました");
      } catch (e) { toast(failMsg(e)); }
    });
  }

  async function saveBill() {
    const c = openCharge(); if (!c) return;
    const pid = S.openPid;
    const amounts = {}, attend = Object.assign({}, c.attend || {});
    let sum = 0;
    for (const it of itemsOf()) {
      const n = document.getElementById("b_" + it.key);
      const v = parseInt(n && n.value !== "" ? n.value : "0", 10);
      if (!(v >= 0)) { toast(`${it.label} の金額を 0 以上の数で入れてください`); return; }
      amounts[it.key] = v; sum += v;
      if (Object.prototype.hasOwnProperty.call(attend, it.key)) {
        const was = attend[it.key];
        attend[it.key] = v > 0 ? "○" : (was === "○" ? "×" : was);
      }
    }
    const note = String(($("#bNote") || {}).value || "").trim().slice(0, 100);
    let res;
    try { res = await writeCharge(pid, c.id, { amounts, attend, note }); }
    catch (e) { toast(failMsg(e)); return; }
    addLog(pid, { member: c.id, name: c.name, action: "請求額を変更", amount: sum });
    const d = $("#sheet details.edit"); if (d) d.open = false;
    toast(res === "queued" ? queuedMsg(c.name) : `${c.name} さんの請求額を ${yen(sum)}円 にしました`);
  }

  /* ---------- トースト ---------- */
  let toastTimer = null;
  function toast(msg, undo) {
    const t = $("#toast"), b = $("#toastBtn");
    $("#toastMsg").textContent = msg;
    b.hidden = !undo;
    b.onclick = undo ? () => { t.hidden = true; clearTimeout(toastTimer); undo(); } : null;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 8000 : 4000);
  }

  /* ---------- CSV ---------- */
  function exportCsv() {
    const p = curPeriod();
    if (!p || !S.charges.length) { toast("保存する記録がまだありません"); return; }
    const its = itemsOf();
    const head = ["No.", "区分", "部員名", ...its.map(i => i.label), "請求額計", "受取額", "未収額", "状態", "受取日", "受け取った幹事", "備考", "メモ"];
    const rows = S.charges.map(c => {
      const r = calc(c), pd = c.paid || {};
      return [c.no != null ? c.no : "", c.group || "", c.name || "", ...its.map(i => Number(c.amounts && c.amounts[i.key]) || 0), r.due, r.rec, r.left, ST_LABEL[r.st], pd.date ? String(pd.date).replace(/-/g, "/") : "", kanjiName(pd.receiver), c.note || "", pd.memo || ""];
    });
    const cell = v => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = "﻿" + [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
    const name = `${p.label || p.id}_集金記録_${today().replace(/-/g, "")}.csv`;
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = el("a", { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast("CSV を保存しました");
    } catch (e) { toast("CSV を保存できませんでした"); }
  }

  /* ---------- データの購読 ---------- */
  function stopAll() {
    for (const k of Object.keys(S.unsub)) { try { S.unsub[k] && S.unsub[k](); } catch (e) { /* 無視 */ } }
    S.unsub = {};
  }
  function onErr(e) {
    const code = e && e.code;
    if (code === "permission-denied") {
      if (S.gate !== "denied") { stopAll(); showGate("denied"); }
      return;
    }
    setBanner("err", "記録データを読み込めませんでした。通信状態を確かめて、ページを開き直してください。");
  }
  function choosePeriod() {
    if (!S.periods.length) return;
    const has = id => S.periods.some(p => p.id === id);
    const saved = LS.get("shukin.period", "");
    const pid = S.pid && has(S.pid) ? S.pid
      : has(saved) ? saved
      : (S.config && has(S.config.currentPeriod)) ? S.config.currentPeriod
      : S.periods[S.periods.length - 1].id;
    if (pid !== S.pid) setPeriod(pid);
  }
  function setPeriod(pid) {
    S.pid = pid; LS.set("shukin.period", pid);
    S.charges = []; S.chargesReady = false; S.log = [];
    if (S.unsub.charges) S.unsub.charges();
    if (S.unsub.log) S.unsub.log();
    if (S.openId) closeSheet();
    S.unsub.charges = S.A.watchCol(`periods/${pid}/charges`, null, (docs, meta) => {
      if (S.pid !== pid) return;
      S.charges = docs.map(d => Object.assign({ id: d.id, __pending: !!d.pending }, d.data())).sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!meta.fromCache) {
        S.chargesReady = true; clearTimeout(S.loadTimer);
        if ($("#banner").dataset.kind === "warn") setBanner("", "");
      }
      renderAll();
    }, onErr);
    S.unsub.log = S.A.watchCol("log", ["period", "==", pid], docs => {
      if (S.pid !== pid) return;
      S.log = docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      renderLog();
    }, () => { /* 履歴が読めなくても集金帳は使える */ });
    renderAll(); renderLog();
  }
  function watchBase() {
    S.periodsReady = false;
    clearTimeout(S.loadTimer);
    S.loadTimer = setTimeout(() => {
      if (!S.chargesReady && S.gate !== "denied") setBanner("warn", "記録データにまだ接続できません。通信状態を確かめてください。つながりしだい表示します。");
    }, 10000);
    S.unsub.config = S.A.watchDoc("config/app", d => { S.config = d.exists ? d.data() : null; renderAll(); }, onErr);
    S.unsub.periods = S.A.watchCol("periods", null, (docs, meta) => {
      S.periods = docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!meta.fromCache) S.periodsReady = true;
      if (S.periods.length) { showApp(); choosePeriod(); renderAll(); }
      else if (S.periodsReady && S.gate !== "import") { clearTimeout(S.loadTimer); setBanner("", ""); showGate("import"); }
    }, onErr);
  }

  /* ---------- 外から呼ばれる入口 ---------- */
  function start(adapter) {
    S.started = true; S.A = adapter;
    adapter.onAuth(u => {
      stopAll();
      S.me = u; S.config = null; S.periods = []; S.charges = []; S.log = []; S.pid = null;
      S.importDocs = null; setBanner("", "");
      renderAcct();
      if (!u) { showGate("signin"); return; }
      showGate("loading");
      watchBase();
    });
  }
  function notConfigured() { S.started = true; showGate("config"); }
  function loadFailed(msg) { S.started = true; showGate("loadfail", msg); }

  for (const b of document.querySelectorAll("#filterSeg button")) {
    b.addEventListener("click", () => { S.filter = b.dataset.f; LS.set("shukin.filter", S.filter); renderList(); });
  }
  $("#q").addEventListener("input", e => { S.q = e.target.value; renderList(); });
  $("#scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && S.openId) closeSheet(); });
  $("#csvBtn").addEventListener("click", exportCsv);
  $("#signOutBtn").addEventListener("click", () => { if (S.A) Promise.resolve(S.A.signOut()).catch(() => {}); });
  setTimeout(() => { if (!S.started) loadFailed("15 秒待っても部品が届きませんでした。"); }, 15000);

  return { start, notConfigured, loadFailed };
})();
