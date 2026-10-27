"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = t => new Date(t).toLocaleString(lang === "en" ? "en-US" : "ar-SA", { dateStyle: "medium", timeStyle: "short" });
// يترجم نصوص القوالب (نص بين وسمين، أو placeholder) للإنجليزي
const tr = html => {
  if (lang !== "en") return html;
  for (const [ar, en] of Object.entries(EN)) {
    if (!html.includes(ar)) continue;
    html = html.split(">" + ar + "<").join(">" + en + "<").split(">" + ar + " <").join(">" + en + " <")
      .split('placeholder="' + ar + '"').join('placeholder="' + en + '"');
  }
  return html;
};
function applyStatic() {
  document.documentElement.lang = lang; document.documentElement.dir = lang === "en" ? "ltr" : "rtl";
  document.querySelectorAll("[data-i]").forEach(el => { el.dataset.ar ??= el.textContent.trim(); el.textContent = t(el.dataset.ar); });
  document.querySelectorAll("[data-iph]").forEach(el => { el.dataset.arPh ??= el.placeholder; el.placeholder = t(el.dataset.arPh); });
}
const safeUrl = u => (/^https?:\/\//i.test(u || "") ? u : "");

const TABS = ["streams", "comments", "news", "social", "tickets", "kick", "users", "discord"];
let me = null, tab = (location.hash || "#streams").slice(1);
if (!TABS.includes(tab)) tab = "streams";
let uq = "", uTimer;
const data = { streams: [], comments: [], news: [], users: [], kick: null, cfg: {}, mine: [], tickets: [], social: [], discord: [] };
const isAdmin = () => me?.role === "admin";

async function api(path, method = "GET", body) {
  const r = await fetch("/api/" + path, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "osamah", "X-Lang": lang },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || t("صار خطأ"));
  return j;
}
const act = async fn => { try { await fn(); } catch (e) { alert(e.message); } };

async function load() {
  const [s, n, c] = await Promise.all([api("streams"), api("news"), api("comments")]);
  data.streams = s; data.news = n; data.comments = c;
  data.cfg = await api("config"); data.social = await api("social"); data.discord = await api("discord").catch(() => []);
  data.mine = me ? await api("support/mine") : [];
  data.tickets = isAdmin() ? await api("admin/support") : [];
  if (isAdmin()) { data.users = await api("admin/users?q=" + encodeURIComponent(uq)); data.kick = await api("admin/kick"); }
  render();
}

function renderTop() {
  const lg = `<button class="btn g s" data-a="lang">${lang === "en" ? "عربي" : "EN"}</button>`;
  $("#top").innerHTML = me
    ? `<span class="chip">${isAdmin() ? ico("shield") + " " + t("مشرف") + " • " : ""}${esc(me.name)}</span><div class="tg">${lg}<button class="btn g s" data-a="logout">${t("خروج")}</button></div>`
    : `<span></span><div class="tg">${lg}<button class="btn s" data-a="login">${t("تسجيل الدخول")}</button></div>`;
  $("#usersTab").hidden = !isAdmin(); $("#kickTab").hidden = !isAdmin(); $("#ticketsTab").hidden = !isAdmin();
  const open = data.tickets.filter(x => x.status === "open").length;
  $("#usersTab").textContent = t("المستخدمين"); $("#kickTab").textContent = t("ربط Kick");
  $("#ticketsTab").textContent = t("التذاكر") + (open ? ` (${open})` : "");
}
const del = (c, id) => isAdmin() ? `<button class="btn d" data-del="${c}:${id}">${t("حذف")}</button>` : "";
const badge = s => s === "live" ? `<span class="badge live">${t("● مباشر")}</span>` : s === "soon" ? `<span class="badge">${t("قريباً")}</span>` : `<span class="badge">${t("انتهى")}</span>`;

const who = x => x.streamer || "OSAMAH";
function renderLive() {
  const lv = data.streams.filter(x => x.status === "live");
  document.title = (lv.length ? t("● مباشر • ") : "") + t("OSAMAH | الموقع الرسمي");
  $("#live").innerHTML = lv.map(x => { const u = safeUrl(x.url);
    return `<div class="livebar"><div><span class="dot"></span><b>${esc(who(x))} ${lang === "en" ? "is live now!" : "يبث الآن!"}</b> <span class="meta">${esc(x.title)}</span></div>${u ? `<a class="btn" target="_blank" rel="noopener" href="${esc(u)}">${t("شاهد الآن")}</a>` : ""}</div>`; }).join("");
}
function render() {
  renderTop(); renderLive();
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === tab));
  $("#view").innerHTML = tr(tab === "streams" ? streamsHTML() : tab === "comments" ? commentsHTML() : tab === "news" ? newsHTML() : tab === "kick" ? kickHTML() : tab === "social" ? socialHTML() : tab === "tickets" ? ticketsHTML() : tab === "users" ? usersHTML() : discordHTML());
}

function streamsHTML() {
  const f = isAdmin() ? `<div class="card admin"><b>${ib("shield", "إضافة بث (للمشرفين فقط)")}</b>
    <input id="sW" placeholder="اسم الستريمر (اختياري)" maxlength="40"><input id="sT" placeholder="عنوان البث" maxlength="120"><input id="sU" dir="ltr" placeholder="رابط البث https://...">
    <select id="sS"><option value="live">مباشر الآن</option><option value="soon">قريباً</option><option value="ended">انتهى</option></select>
    <button class="btn" data-a="addStream">نشر البث</button></div>` : "";
  const L = data.streams.map(s => `<div class="card"><h3>${esc(s.title)}${badge(s.status)}${s.source === "kick" ? '<span class="badge">Kick</span>' : ""}${del("streams", s.id)}</h3>
    <div class="meta"><span class="who">${ico("user")} ${esc(who(s))}</span> • ${fmt(s.created_at)}</div>
    ${safeUrl(s.url) ? `<a class="btn" target="_blank" rel="noopener" href="${esc(s.url)}">${s.status === "ended" ? "شاهد الإعادة" : "شاهد البث"}</a>` : ""}
    ${isAdmin() && s.status !== "ended" ? `<button class="btn g" data-end="${s.id}">إنهاء البث</button>` : ""}</div>`).join("");
  return f + (L || '<div class="empty">ما فيه بثوث حالياً، ترقبوا!</div>');
}
function commentsHTML() {
  const f = me ? `<div class="card"><b>شاركنا رأيك</b><textarea id="cT" rows="3" maxlength="500" placeholder="اكتب تعليقك..."></textarea><button class="btn" data-a="addComment">إرسال التعليق</button></div>`
    : `<div class="card note">سجّل دخولك عشان تقدر تعلّق. <button class="btn s" data-a="login">تسجيل الدخول</button></div>`;
  const L = data.comments.map(c => `<div class="card cm"><div class="av">${esc(c.name.charAt(0).toUpperCase())}</div><div>
    <div class="meta"><b>${esc(c.name)}</b>${c.role === "admin" ? " " + ico("shield") : ""} • ${fmt(c.created_at)}${(isAdmin() || me?.id === c.user_id) ? `<button class="btn d" data-del="comments:${c.id}">${t("حذف")}</button>` : ""}</div>
    <div>${esc(c.text)}</div>
    <button class="like${c.liked ? " on" : ""}" data-like="${c.id}">${ico("heart")} ${c.likes}</button></div></div>`).join("");
  return f + (L || '<div class="empty">كن أول من يعلّق</div>');
}
function newsHTML() {
  const f = isAdmin() ? `<div class="card admin"><b>${ib("shield", "إضافة خبر (للمشرفين فقط)")}</b><input id="nT" placeholder="عنوان الخبر" maxlength="150"><textarea id="nB" rows="4" placeholder="تفاصيل الخبر"></textarea><button class="btn" data-a="addNews">نشر الخبر</button></div>` : "";
  const L = data.news.map(n => `<div class="card"><h3>${esc(n.title)}${del("news", n.id)}</h3><div class="meta">${fmt(n.created_at)}</div><div class="pre">${esc(n.body)}</div></div>`).join("");
  return f + (L || '<div class="empty">لا توجد أخبار بعد</div>');
}
const noMail = u => /@(discord|google)\.local$/.test(u.email); // حساب Discord بدون إيميل حقيقي
const userRows = () => data.users.map(u => `<div class="card row"><div><b>${esc(u.name)}</b> ${u.provider ? ico(u.provider) + " " : ""}${noMail(u) ? "" : `<span class="meta" dir="ltr">${esc(u.email)}</span>`}<br>
    <span class="badge ${u.role === "admin" ? "live" : ""}">${t(u.role === "admin" ? "مشرف" : "عضو")}</span> <span class="meta">${fmt(u.created_at)}</span></div>
    <div class="acts">${u.id === me.id ? "" : `<button class="btn g s" data-role="${u.id}:${u.role === "admin" ? "user" : "admin"}">${t(u.role === "admin" ? "إزالة الإشراف" : "ترقية لمشرف")}</button>`}
    ${noMail(u) ? "" : `<button class="btn g s" data-upw="${u.id}">${t("إعادة تعيين الباسورد")}</button>`}
    ${u.id === me.id ? "" : `<button class="btn d" data-udel="${u.id}">${t("حذف")}</button>`}</div></div>`).join("") || `<div class="empty">${t("ما فيه مستخدمين مطابقين")}</div>`;
function usersHTML() {
  if (!isAdmin()) return "";
  return `<input id="uQ" placeholder="${t("بحث بالاسم أو الإيميل...")}" value="${esc(uq)}" autocomplete="off"><div id="ulist">${userRows()}</div>`;
}
document.addEventListener("input", e => {
  if (e.target.id !== "uQ") return;
  uq = e.target.value.trim(); clearTimeout(uTimer);
  uTimer = setTimeout(async () => { try { data.users = await api("admin/users?q=" + encodeURIComponent(uq)); $("#ulist").innerHTML = userRows(); } catch (_) {} }, 300);
});

const tStat = x => x.status === "open" ? `<span class="badge live">${t("مفتوحة")}</span>` : `<span class="badge">${t("مغلقة")}</span>`;
const PL = { kick: ["kick", "Kick"], twitch: ["twitch", "Twitch"], youtube: ["youtube", "YouTube"], x: ["x", "X (تويتر)"], instagram: ["instagram", "Instagram"], tiktok: ["tiktok", "TikTok"], snapchat: ["snapchat", "Snapchat"], discord: ["discord", "Discord"], telegram: ["telegram", "Telegram"], whatsapp: ["whatsapp", "WhatsApp"], facebook: ["facebook", "Facebook"], other: ["link", "رابط"] };
function socialHTML() {
  const f = isAdmin() ? `<div class="card admin"><b>${ib("shield", "إضافة حساب (للمشرفين فقط)")}</b>
    <select id="oP">${Object.entries(PL).map(([k, v]) => `<option value="${k}">${t(v[1])}</option>`).join("")}</select>
    <input id="oT" placeholder="اسم الحساب (مثال: @osamah)" maxlength="60"><input id="oU" dir="ltr" placeholder="الرابط https://...">
    <button class="btn" data-a="addSocial">إضافة</button></div>` : "";
  const L = data.social.map(x => { const [ic, nm] = PL[x.platform] || PL.other;
    return `<div class="card p-${PL[x.platform] ? x.platform : "other"}${["kick", "snapchat", "whatsapp"].includes(x.platform) ? " light" : ""}"><div class="ic">${ico(ic)}</div><h3>${esc(t(nm))}</h3><div class="meta" dir="auto">${esc(x.title)}</div>
    <div><a class="btn" target="_blank" rel="noopener" href="${esc(safeUrl(x.url))}">زيارة</a>${del("social", x.id)}</div></div>`; }).join("");
  return f + (L ? `<div class="soc sc">${L}</div>` : '<div class="empty">ما انضافت حسابات بعد</div>');
}
function discordHTML() {
  const f = isAdmin() ? `<div class="card admin"><b>${ib("shield", "إضافة عضو لقسم الدسكورد (للمشرفين فقط)")}</b>
    <select id="dCat">
      <option value="upper">الإدارة العليا</option>
         <option value="programmers">المبرمجين</option>
      <option value="middle">الإدارة الوسطى</option>
      <option value="juniors">الإدارة الصغرى</option>
    </select>
    <input id="dN" placeholder="اسم العضو أو اللقب" maxlength="60">
    <input id="dU" dir="ltr" placeholder="رابط الدسكورد أو الملف الشخصي https://...">
    <button class="btn" data-a="addDiscordMember">إضافة عضو</button></div>` : "";

      const categories = [
          { id: "upper", icon: "crown", title: "الإدارة العليا" },
          { id: "programmers", icon: "code", title: "المبرمجين" },
          { id: "middle", icon: "zap", title: "الإدارة الوسطى" },
          { id: "juniors", icon: "star", title: "الإدارة الصغرى" }
        ];

  const content = categories.map(cat => {
    const members = (data.discord || []).filter(m => m.category === cat.id);
    const L = members.map(m => `<div class="card row">
      <div><b>${esc(m.name)}</b></div>
      <div>
        ${safeUrl(m.url) ? `<a class="btn s" target="_blank" rel="noopener" href="${esc(m.url)}">زيارة</a>` : ""}
        ${del("discord", m.id)}
      </div>
    </div>`).join("") || '<div class="empty">ما فيه أعضاء هنا بعد</div>';

    return `<div class="card"><h3>${ico(cat.icon)} <span>${cat.title}</span></h3><div class="soc">${L}</div></div>`;
  }).join("");

  return f + content;
}

const supBody = () => { $("#supBody").innerHTML = tr(supportHTML()); };
function openSupport() { supBody(); $("#sup").hidden = false; }
function supportHTML() {
  const c = data.cfg || {};
  const links = [c.supportEmail ? `<a class="btn g" href="mailto:${esc(c.supportEmail)}">${ico("mail")} ${esc(c.supportEmail)}</a>` : "",
    c.supportDiscord ? `<a class="btn g" target="_blank" rel="noopener" href="${esc(c.supportDiscord)}">${ico("discord")} <span>${t("ديسكورد الدعم")}</span></a>` : ""].join("");
  const form = `<div class="card"><h3>تواصل مع الدعم الفني</h3><div class="meta">واجهتك مشكلة أو عندك اقتراح؟ اكتب لنا ونرد عليك بأقرب وقت. (رسالة وحدة كل 6 ساعات)</div>
    <input id="tN" placeholder="الاسم" maxlength="40" value="${esc(me?.name || "")}">
    <input id="tE" type="email" dir="ltr" placeholder="الإيميل للرد عليك" value="${esc(me?.email || "")}">
    <input id="tS" placeholder="عنوان المشكلة" maxlength="100">
    <textarea id="tM" rows="5" maxlength="2000" placeholder="اشرح المشكلة بالتفصيل..."></textarea>
    <button class="btn" data-a="addTicket">إرسال</button>${links ? `<div class="meta sup">${t("أو تواصل مباشرة:")}</div>${links}` : ""}</div>`;
  const mine = data.mine.map(k => `<div class="card"><h3>${esc(k.subject)}${tStat(k)}</h3><div class="meta">${fmt(k.created_at)}</div>
    <div class="pre">${esc(k.message)}</div>${k.reply ? `<div class="reply"><b>${t("رد الدعم:")}</b><div class="pre">${esc(k.reply)}</div></div>` : ""}</div>`).join("");
  return form + (me ? `<h3 class="sec">${t("رسائلك السابقة")}</h3>${mine || '<div class="empty">ما أرسلت أي رسالة بعد</div>'}` : '<div class="note">سجّل دخولك عشان تتابع ردود الدعم هنا.</div>');
}
function ticketsHTML() {
  if (!isAdmin()) return "";
  return data.tickets.map(k => `<div class="card"><h3>${esc(k.subject)}${tStat(k)}${del("support", k.id).replace("data-del", "data-tdel")}</h3>
    <div class="meta">${esc(k.name)} • <a href="mailto:${esc(k.email)}?subject=${encodeURIComponent(t("رد: ") + k.subject)}" dir="ltr">${esc(k.email)}</a> • ${fmt(k.created_at)}${t(k.user_id ? " • عضو مسجّل" : " • زائر")}</div>
    <div class="pre">${esc(k.message)}</div>
    <textarea id="r${k.id}" rows="2" maxlength="2000" placeholder="الرد (يظهر للعضو المسجّل في صفحة الدعم)">${esc(k.reply)}</textarea>
    <button class="btn" data-reply="${k.id}">${t(k.status === "open" ? "رد وإغلاق" : "تحديث الرد")}</button>
    ${k.status === "open" ? `<button class="btn g" data-tclose="${k.id}:closed">${t("إغلاق بدون رد")}</button>` : `<button class="btn g" data-tclose="${k.id}:open">${t("إعادة فتح")}</button>`}</div>`).join("") || '<div class="empty">ما فيه تذاكر</div>';
}

function kickHTML() {
  const k = data.kick; if (!isAdmin() || !k) return "";
  const warn = k.enabled ? "" : lang === "en"
    ? `<div class="card note">Kick link is not enabled: set <b dir="ltr">KICK_CLIENT_ID</b> and <b dir="ltr">KICK_CLIENT_SECRET</b> in the <b dir="ltr">.env</b> file, then restart the server.</div>`
    : `<div class="card note">الربط غير مفعّل: حط <b dir="ltr">KICK_CLIENT_ID</b> و<b dir="ltr">KICK_CLIENT_SECRET</b> في ملف <b dir="ltr">.env</b> ثم أعد تشغيل السيرفر.</div>`;
  const L = k.channels.map(c => `<div class="card row"><div><b dir="ltr">${esc(c.slug)}</b>
    ${c.error ? `<span class="badge">${esc(c.error)}</span>` : c.live ? '<span class="badge live">● مباشر</span>' : c.checked ? '<span class="badge">غير مباشر</span>' : '<span class="badge">بانتظار الفحص</span>'}</div>
    <button class="btn d" data-kdel="${esc(c.slug)}">إزالة</button></div>`).join("");
  return warn + `<div class="card admin"><b>${ib("shield", "اليوزرات المربوطة من Kick")}</b>
    <div class="meta">أي بث لهذي اليوزرات ينزل تلقائياً في الموقع ويطلع التنبيه فوق.</div>
    <input id="kS" dir="ltr" placeholder="يوزر Kick أو رابط القناة"><button class="btn" data-a="addKick">ربط</button></div>` + (L || '<div class="empty">ما فيه يوزرات مربوطة</div>');
}

// ---- الأحداث ----
$("#tabs").onclick = e => { const t = e.target.dataset?.t; if (t) { tab = t; history.replaceState(null, "", "#" + t); render(); } };
document.addEventListener("click", e => {
  const el = e.target.closest("[data-a],[data-like],[data-del],[data-end],[data-role],[data-upw],[data-udel],[data-kdel],[data-tdel],[data-reply],[data-tclose]") || e.target;
  const d = el.dataset || {};
  if (d.a === "login") openAuth("login");
  else if (d.a === "discordLogin") location.href = "/api/auth/discord";
  else if (d.a === "googleLogin") location.href = "/api/auth/google";
  else if (d.a === "lang") setLang(lang === "en" ? "ar" : "en");
  else if (d.a === "logout") act(async () => { await api("logout", "POST", {}); me = null; tab = tab === "users" ? "streams" : tab; await load(); });
  else if (d.del) { const [c, id] = d.del.split(":"); if (confirm(t("متأكد من الحذف؟"))) act(async () => { await api(`${c}/${id}`, "DELETE"); await load(); }); }
  else if (d.end) act(async () => { await api("streams/" + d.end, "PATCH", { status: "ended" }); await load(); });
  else if (d.like) {
    if (!me) return openAuth("login");
    const btn = el; act(async () => { const r = await api(`comments/${d.like}/like`, "POST", {}); btn.innerHTML = `${ico("heart")} ${r.likes}`; btn.classList.toggle("on", r.liked); });
  }
  else if (d.udel) { if (confirm(t("حذف المستخدم وكل تعليقاته؟"))) act(async () => { await api("admin/users/" + d.udel, "DELETE"); await load(); }); }
  else if (d.upw) {
    const u = data.users.find(x => x.id === Number(d.upw)); const nm = u ? u.name : "";
    if (confirm(lang === "en" ? `Reset the password for ${nm}? They will be logged out of all devices.` : `إعادة تعيين كلمة مرور ${nm}؟ بيتسجل خروجه من كل الأجهزة.`))
      act(async () => { const r = await api(`admin/users/${d.upw}/reset-password`, "POST", {}); prompt(t("الباسورد الجديد (انسخه وأعطه للمستخدم، ما يظهر مرة ثانية):"), r.password); });
  }
  else if (d.role) { const [id, role] = d.role.split(":"); act(async () => { await api("admin/users/" + id, "PATCH", { role }); await load(); }); }
  else if (d.tdel) { if (confirm(t("حذف التذكرة؟"))) act(async () => { await api("admin/support/" + d.tdel.split(":")[1], "DELETE"); await load(); }); }
  else if (d.reply) act(async () => { await api("admin/support/" + d.reply, "PATCH", { reply: $("#r" + d.reply).value, status: "closed" }); await load(); });
  else if (d.tclose) { const [id, status] = d.tclose.split(":"); act(async () => { await api("admin/support/" + id, "PATCH", { status }); await load(); }); }
  else if (d.a === "openSupport") openSupport();
  else if (d.a === "closeSupport") $("#sup").hidden = true;
  else if (d.a === "addDiscordMember") { const name = $("#dN").value.trim(), url = $("#dU").value.trim(), category = $("#dCat").value; if (!name) return; act(async () => { await api("discord", "POST", { name, url, category }); await load(); }); }
  else if (d.a === "addSocial") { const title = $("#oT").value.trim(), url = $("#oU").value.trim(); if (!title || !url) return; act(async () => { await api("social", "POST", { platform: $("#oP").value, title, url }); await load(); }); }
  else if (d.a === "addTicket") act(async () => {
    await api("support", "POST", { name: $("#tN").value, email: $("#tE").value, subject: $("#tS").value, message: $("#tM").value });
    alert(t("وصلتنا رسالتك، بنرد عليك قريب")); await load(); supBody();
  });
  else if (d.kdel) act(async () => { await api("admin/kick/" + encodeURIComponent(d.kdel), "DELETE"); await load(); });
  else if (d.a === "addKick") { const slug = $("#kS").value.trim(); if (!slug) return; act(async () => { await api("admin/kick", "POST", { slug }); await load(); }); }
  else if (d.a === "addStream") { const title = $("#sT").value.trim(); if (!title) return; act(async () => { await api("streams", "POST", { title, streamer: $("#sW").value.trim(), url: $("#sU").value.trim(), status: $("#sS").value }); await load(); }); }
  else if (d.a === "addNews") { const title = $("#nT").value.trim(); if (!title) return; act(async () => { await api("news", "POST", { title, body: $("#nB").value.trim() }); await load(); }); }
  else if (d.a === "addComment") { const text = $("#cT").value.trim(); if (!text) return; act(async () => { await api("comments", "POST", { text }); await load(); }); }
});

function setLang(l) {
  lang = l; try { localStorage.setItem("lang", l); } catch (_) {}
  applyStatic(); render();
  if (!$("#sup").hidden) supBody();
  if (!$("#auth").hidden) openAuth(mode);
}
// ---- تسجيل الدخول / التسجيل ----
let mode = "login";
function openAuth(m) {
  mode = m;
  $("#authTitle").textContent = t(m === "login" ? "تسجيل الدخول" : "إنشاء حساب");
  $("#aName").hidden = m === "login";
  $("#aGo").textContent = t(m === "login" ? "دخول" : "تسجيل");
  $("#aSwitch").textContent = t(m === "login" ? "ما عندك حساب؟ سجّل الحين" : "عندك حساب؟ سجّل دخولك");
  $("#aPass").autocomplete = m === "login" ? "current-password" : "new-password";
  const cf = data.cfg || {}; $("#aGoogle").hidden = !cf.googleLogin; $("#aDiscord").hidden = !cf.discordLogin; $("#aOr").hidden = !(cf.googleLogin || cf.discordLogin);
  $("#aErr").textContent = ""; $("#auth").hidden = false; $("#aEmail").focus();
}
$("#aSwitch").onclick = e => { e.preventDefault(); openAuth(mode === "login" ? "register" : "login"); };
$("#aClose").onclick = () => { $("#auth").hidden = true; };
$("#aGo").onclick = async () => {
  try {
    const body = { email: $("#aEmail").value, password: $("#aPass").value };
    if (mode === "register") body.name = $("#aName").value;
    me = (await api(mode, "POST", body)).user;
    $("#auth").hidden = true; $("#aPass").value = "";
    await load();
  } catch (e) { $("#aErr").textContent = e.message; }
};

$(".fab").insertAdjacentHTML("afterbegin", ico("message"));
$("#aDiscord").insertAdjacentHTML("afterbegin", ico("discord"));
$("#aGoogle").insertAdjacentHTML("afterbegin", ico("google"));
// رسالة خطأ لو رجع المستخدم من Discord بفشل أو إلغاء
const AUTH_ERR = { oauth_failed: "ما قدرنا نسجّل دخولك، جرّب مرة ثانية", oauth_denied: "تم إلغاء تسجيل الدخول", oauth_off: "هذا النوع من تسجيل الدخول غير مفعّل", oauth_busy: "محاولات كثيرة، جرّب بعد شوي" };
const authErr = new URLSearchParams(location.search).get("auth_error");
if (authErr) { history.replaceState(null, "", location.pathname + location.hash); setTimeout(() => alert(t(AUTH_ERR[authErr] || "صار خطأ")), 300); }
applyStatic();
(async () => { try { me = (await api("me")).user; } catch (_) {} await load(); })();

// تحديث تلقائي: التنبيه والبثوث يتحدثون بدون ما تعيد تحميل الصفحة
let sig = "";
setInterval(async () => {
  if (document.hidden) return;
  try {
    const st = await api("streams");
    const ns = JSON.stringify(st);
    if (ns === sig) return;
    sig = ns; data.streams = st; renderLive();
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if (tab === "streams" && !typing) render();
    if (isAdmin() && tab === "kick" && !typing) { data.kick = await api("admin/kick"); render(); }
  } catch (_) {}
}, 20000);
