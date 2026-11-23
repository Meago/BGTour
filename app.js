'use strict';

const PIPS = { 1:[5], 2:[1,9], 3:[1,5,9], 4:[1,3,7,9], 5:[1,3,5,7,9], 6:[1,3,4,6,7,9] };
const state = {
  tournament:null, games:{}, viewerId:null, token:null, code:null, revision:0,
  modal:null, source:null, pollTimer:null, clockTimer:null, busy:false, refreshing:false,
  serverOffset:0, selectedFrom:null, watchedMatchId:null, toastTimer:null, pendingJoinCode:'',
  dashboardTab:'overview', presentation:false
};
const site = document.getElementById('site');
const modalRoot = document.getElementById('modal-root');

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function initials(name) { return String(name||'ש').trim().split(/\s+/).slice(0,2).map(part=>part[0]||'').join('').toUpperCase()||'ש'; }
function normalizeCode(code) { return String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function codePath(code) { return `/api/tournaments/${encodeURIComponent(code)}`; }
function player(playerId) { return state.tournament?.players.find(item=>item.id===playerId)||null; }
function myPlayer() { return player(state.viewerId); }
function currentRound() { const rounds=state.tournament?.rounds||[]; return rounds[rounds.length-1]||null; }
function currentMatches() { return currentRound()?.matches||[]; }
function currentMatch() { return currentMatches().find(match=>match.p2&&(match.p1===state.viewerId||match.p2===state.viewerId))||null; }
function myGame() { const match=currentMatch(); return match?state.games[match.id]||null:null; }
function sideForMatch(match) { return match?.p1===state.viewerId?'w':match?.p2===state.viewerId?'b':null; }
function nameOf(playerId) { return player(playerId)?.name||'שחקן/ית'; }
function setUrl(code) { history.replaceState(null,'',`${location.pathname}?room=${encodeURIComponent(code)}`); }
function sessionKey(code) { return `pip-seat:${normalizeCode(code)}`; }
function saveSeat(code,token) { try { sessionStorage.setItem(sessionKey(code),token); } catch {} }
function savedSeat(code) { try { return sessionStorage.getItem(sessionKey(code))||''; } catch { return ''; } }

async function request(url,body) {
  const response=await fetch(url,body===undefined?{headers:{'Accept':'application/json'}}:{
    method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)
  });
  let data={};
  try { data=await response.json(); } catch {}
  if(!response.ok) throw new Error(data.error||`הבקשה נכשלה (${response.status}).`);
  return data;
}
function setSnapshot(data,force=false) {
  if(!data?.tournament) return;
  if(!force&&state.code===data.tournament.code&&data.revision<state.revision) return;
  const nextCode=data.tournament.code;
  if(force||state.code!==nextCode||data.revision>state.revision) state.selectedFrom=null;
  if(state.code!==nextCode) { state.watchedMatchId=null; state.dashboardTab='overview'; state.presentation=false; }
  if(data.tournament.status!=='live') state.presentation=false;
  state.code=nextCode;
  state.tournament=data.tournament;
  state.games=data.games||{};
  state.viewerId=data.viewerId||null;
  state.revision=data.revision||0;
  const receivedAt=Date.now();
  state.serverOffset=Number(data.serverNow||receivedAt)-receivedAt;
  if(state.watchedMatchId&&!currentMatches().some(match=>match.id===state.watchedMatchId&&match.status==='live')) state.watchedMatchId=null;
  render();
}
function closeConnection() {
  if(state.source) { state.source.close(); state.source=null; }
  if(state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer=null; }
}
function connectRoom(code,token) {
  closeConnection();
  state.code=code; state.token=token||'';
  const url=`${codePath(code)}/events?token=${encodeURIComponent(state.token)}`;
  if('EventSource' in window) {
    state.source=new EventSource(url);
    state.source.addEventListener('update',event=>{
      try { const notice=JSON.parse(event.data); if(notice.revision>state.revision) refreshRoom(); } catch { refreshRoom(); }
    });
    state.source.onerror=()=>{};
  }
  state.pollTimer=setInterval(refreshRoom,5000);
}
async function refreshRoom() {
  if(!state.code||state.refreshing) return;
  state.refreshing=true;
  try {
    const data=await request(`${codePath(state.code)}?token=${encodeURIComponent(state.token||'')}`);
    if(data.revision>state.revision||!state.tournament) setSnapshot(data);
  } catch(error) {
    if(/חדר הטורניר|מושב|room not found|not recognized/i.test(error.message)) showToast(error.message);
  } finally { state.refreshing=false; }
}
async function roomPost(path,payload={},successMessage='') {
  if(!state.code||!state.token) { showToast('צריך להצטרף מחדש לחדר כדי להשתמש במושב שלך.'); return; }
  if(state.busy) return;
  state.busy=true;
  render();
  try {
    const data=await request(`${codePath(state.code)}${path}`,{...payload,token:state.token});
    setSnapshot(data);
    if(successMessage) showToast(successMessage);
  } catch(error) { showToast(error.message); }
  finally { state.busy=false; render(); }
}
function showToast(message) {
  const toast=document.getElementById('toast');
  toast.textContent=message; toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer=setTimeout(()=>toast.classList.remove('show'),3000);
}
function fmtPoints(value) { return Number(value||0).toFixed(1); }
function buchholz(person) { return (person.opponents||[]).reduce((sum,id)=>sum+(player(id)?.points||0),0); }
function standings() {
  const early=state.tournament?.finishReason==='host-early';
  const list=[...(state.tournament?.players||[])].sort((a,b)=>{
    if(early) return b.points-a.points||b.elo-a.elo||buchholz(b)-buchholz(a)||b.wins-a.wins||a.name.localeCompare(b.name);
    return b.points-a.points||b.wins-a.wins||buchholz(b)-buchholz(a)||b.elo-a.elo||a.name.localeCompare(b.name);
  });
  let previous='',rank=0;
  return list.map((person,index)=>{
    const key=early?[person.points,person.elo,buchholz(person),person.wins].join('|'):[person.points,person.wins,buchholz(person),person.elo].join('|');
    if(key!==previous) rank=index+1;
    previous=key;
    return {...person,rank};
  });
}
function isHost() { return !!state.tournament&&state.viewerId===state.tournament.hostId; }
function footer() { return `<footer class="footer-note"><span>◈ PIP &amp; CROWN <i class="footer-dot">•</i> עוד משחק אחד?</span><span>ללא חשבונות <i class="footer-dot">•</i> דירוג Elo חדש לכל טורניר <i class="footer-dot">•</i> בלי הדחות</span></footer>`; }
function roundsLabel(t=state.tournament) {
  if(t?.settings?.unlimitedRounds) return 'ללא הגבלת סיבובים';
  const count=t?.totalRounds??t?.settings?.rounds??0;
  return `${count} ${count===1?'סיבוב':'סיבובים'}`;
}
function timeLabel(seconds) {
  const n=Number(seconds)||0;
  if(!n) return 'ללא שעון';
  const minutes=n/60;
  return `${Number.isInteger(minutes)?minutes:minutes.toFixed(1)} דקות לכל שחקן/ית`;
}

function renderHeader() {
  const t=state.tournament,me=myPlayer();
  const status=t?(t.status==='lobby'?'לובי פתוח':t.status==='complete'?'תוצאות הטורניר':'טורניר חי'):'טורנירי שש־בש בחדרים';
  return `<header class="topbar">
    <a class="brand" href="/" data-action="home" aria-label="דף הבית של פיפ וקראון"><span class="brand-mark"><svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z" fill="currentColor"/><path d="M8 5.5h4M5.5 8v4M14.5 8v4M8 14.5h4" stroke="#172016" stroke-width="1.2"/></svg></span><span class="brand-copy"><span class="brand-name">PIP &amp; CROWN</span><span class="brand-sub">מועדון שש־בש</span></span></a>
    <nav class="topnav" aria-label="ניווט ראשי"><span class="nav-link active">${esc(status)}</span><button class="nav-link" data-action="rules">חוקי המשחק</button></nav>
    <span class="topbar-spacer"></span>
    ${t&&me?`<div class="seat-chip"><span class="user-avatar">${esc(initials(me.name))}</span><span><bdi>${esc(me.name)}</bdi><small>${isHost()?'מארח/ת':'שחקן/ית'} · מושב בחדר</small></span></div>`:''}
    <div class="top-actions">${t?`<button class="btn btn-quiet" data-action="join">הצטרפות לחדר</button><button class="btn btn-primary" data-action="host">＋ טורניר חדש</button>`:`<button class="btn btn-quiet" data-action="join">הצטרפות עם קוד</button><button class="btn btn-primary" data-action="host">＋ פתיחת טורניר</button>`}</div>
  </header>`;
}
function renderLanding() {
  const triangles=(half)=>Array.from({length:6},(_,i)=>`<span class="mini-triangle"><span class="mini-stack ${half}">${(half==='top'&&[0,4].includes(i)?[0,1,2]:half==='bottom'&&[1,5].includes(i)?[0,1]:[]).map(n=>`<i class="mini-checker ${half==='top'?'dark':''}" style="--n:${n}"></i>`).join('')}</span></span>`).join('');
  return `<main class="landing-wrap">
    <section class="landing-hero"><div class="landing-copy"><div class="event-kicker"><span class="live-dot" style="background:var(--lime);box-shadow:0 0 0 4px rgba(200,243,108,.12)"></span>החדר שלכם. הלוח שלכם.</div><h1>מטילים.<br><em>משחקים עד הסוף.</em></h1><p>פותחים חדר שש־בש פרטי, משתפים קוד ומריצים טורניר שווייצרי חי. בלי חשבונות ובלי הדחות — רק הלוח, הקוביות והמהלך הבא.</p><div class="landing-actions"><button class="btn btn-primary" data-action="host">פתיחת טורניר <span>←</span></button><button class="btn" data-action="join">הצטרפות עם קוד</button></div><div class="landing-stats"><div class="landing-stat"><strong>ללא הגבלה</strong><span>מספר שחקנים בחדר</span></div><div class="landing-stat"><strong>1200</strong><span>Elo חדש לכל טורניר</span></div><div class="landing-stat"><strong>0</strong><span>הדחות</span></div></div></div>
      <div class="landing-art"><div class="mini-board"><div class="mini-board-inner"><div class="mini-board-side top left">${triangles('top')}</div><div class="mini-board-side top right">${triangles('top')}</div><div class="mini-bar"></div><div class="mini-board-side bottom left">${triangles('bottom')}</div><div class="mini-board-side bottom right">${triangles('bottom')}</div></div></div></div>
    </section>
    <div class="landing-foot-grid"><article class="landing-feature"><span class="feature-icon">↔</span><b>שיטה שווייצרית, לא נוקאאוט</b><p>הצימודים מתחשבים בנקודות ובדירוג Elo. כולם ממשיכים לשחק לאורך הטורניר.</p></article><article class="landing-feature"><span class="feature-icon">◉</span><b>חוקי שש־בש נאכפים</b><p>כניסה מהבר, חסימות, פגיעות, שימוש נכון בקוביות והוצאה חוקית — נבדקים בשרת.</p></article><article class="landing-feature"><span class="feature-icon">◎</span><b>חדר אחד, סולם דירוג חדש</b><p>בוחרים שם בלבד. כל משתתף/ת מתחיל/ה כל טורניר חדש בדירוג 1200.</p></article></div>
    <p class="games-foot landing-privacy">קוד החדר מיועד לקבוצה שלכם. פתיחת הקישור באותו מכשיר מחזירה אתכם למושב.</p>
  </main>`;
}
function renderEventHeading() {
  const t=state.tournament,round=t.currentRound||0,r=currentRound(),matches=r?.matches||[];
  const done=matches.filter(match=>match.status==='complete').length;
  const progress=t.status==='lobby'?Math.min(100,t.players.length/8*100):t.totalRounds?Math.min(100,round/t.totalRounds*100):36;
  const indeterminate=t.status==='live'&&t.settings?.unlimitedRounds;
  const kicker=t.status==='lobby'?'הלובי פתוח':t.status==='complete'?'הטורניר הסתיים':`טורניר חי · סיבוב ${round}`;
  const sub=t.status==='lobby'?'מזמינים את המשתתפים לפני תחילת המשחקים. כולם נשארים בטורניר עד סיומו.':`${t.players.length} שחקנים · שיטה שווייצרית · כולם ממשיכים בכל סיבוב.`;
  const roundMeter=t.status==='lobby'?'ממתינים לשחקנים':t.settings?.unlimitedRounds?`סיבוב ${round} · ללא הגבלה`:`סיבוב ${round} מתוך ${t.totalRounds}`;
  return `<div class="event-heading"><div><div class="event-kicker"><span class="live-dot" style="${t.status==='complete'?'background:var(--lime);box-shadow:0 0 0 4px rgba(200,243,108,.12)':''}"></span>${esc(kicker)}</div><h1><bdi>${esc(t.name)}</bdi></h1><p class="event-subtitle">${esc(sub)}</p></div><div class="event-side"><div class="round-progress"><div class="round-progress-top"><span>${esc(roundMeter)}</span><span>${t.status==='lobby'?`${t.players.length} משתתפים`:`${done}/${matches.length} שולחנות`}</span></div><div class="progress-track"><div class="progress-fill ${indeterminate?'indeterminate':''}" style="width:${progress}%"></div></div></div><div class="code-pill"><span>קוד החדר</span><strong dir="ltr">${esc(t.code)}</strong><button class="copy-code" data-action="copy-code" title="העתקת הקוד" aria-label="העתקת קוד החדר"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5V3.8A1.8 1.8 0 0 0 8.7 2H4.8A1.8 1.8 0 0 0 3 3.8v5.4A1.8 1.8 0 0 0 4.8 11H5" stroke="currentColor" stroke-width="1.4"/></svg></button></div>${t.status==='live'&&isHost()?'<button class="btn btn-danger btn-small finish-tournament-button" data-action="finish-confirm">סיום הטורניר</button>':''}</div></div>`;
}
function settingsFields(settings,formId='settings-form',disabled=false) {
  const s=settings||{rounds:5,unlimitedRounds:false,timePerPlayerSec:0};
  const selected=(value,expected)=>String(value)===String(expected)?'selected':'';
  return `<div class="settings-fields" ${disabled?'aria-disabled="true"':''}>
    <div class="modal-field"><label class="field-label" for="${formId}-round-mode">מספר סיבובים</label><select class="select-input" id="${formId}-round-mode" name="roundMode" ${disabled?'disabled':''}><option value="fixed" ${s.unlimitedRounds?'':'selected'}>מספר קבוע</option><option value="unlimited" ${s.unlimitedRounds?'selected':''}>ללא הגבלה</option></select></div>
    <div class="modal-field"><label class="field-label" for="${formId}-rounds">סיבובים מתוכננים</label><input class="text-input rounds-input" id="${formId}-rounds" type="number" name="rounds" min="1" max="1000" value="${esc(s.rounds||5)}" ${s.unlimitedRounds||disabled?'disabled':''}></div>
    <div class="modal-field full"><label class="field-label" for="${formId}-clock">שעון לכל שחקן/ית</label><select class="select-input" id="${formId}-clock" name="timePerPlayerSec" ${disabled?'disabled':''}>${[[0,'ללא הגבלה'],[60,'דקה אחת'],[180,'3 דקות'],[300,'5 דקות'],[600,'10 דקות'],[900,'15 דקות'],[1800,'30 דקות']].map(([value,label])=>`<option value="${value}" ${selected(s.timePerPlayerSec??0,value)}>${label}</option>`).join('')}</select><small class="field-hint">זהו זמן כולל לכל המשחק. השעון רץ בתור של השחקן/ית בלבד; אזילת הזמן היא הפסד.</small></div>
  </div>`;
}
function renderLobby() {
  const t=state.tournament,me=myPlayer(),roster=t.players,s=t.settings||{rounds:t.totalRounds||5,unlimitedRounds:false,timePerPlayerSec:0};
  return `<main class="page-wrap">${renderEventHeading()}<div class="lobby-layout">
    <section class="card roster-card"><div class="section-head"><div><h2 class="section-title">מי סביב השולחן?</h2><p class="section-note">שם למושב בלבד — בלי חשבון ובלי פרופיל קבוע.</p></div><span class="roster-count">${roster.length} משתתפים</span></div>
      <div class="roster-list">${roster.map(person=>`<div class="roster-person"><span class="mini-avatar" style="${person.isHost?'background:var(--lime);color:#172016':''}">${esc(initials(person.name))}</span><span class="roster-name"><bdi>${esc(person.name)}</bdi>${person.id===state.viewerId?'<small>המושב שלך</small>':person.isHost?'<small>מארח/ת</small>':'<small>הצטרף/ה לחדר</small>'}<small>דירוג הטורניר: 1200 Elo</small></span></div>`).join('')}</div>
      <div class="room-tools"><button class="btn btn-small" data-action="copy-invite">העתקת קישור הזמנה</button><button class="btn btn-small btn-quiet" data-action="copy-code">העתקת קוד</button></div>
      <div class="lobby-status">${roster.length<2?'צריך לפחות משתתף/ת נוסף/ת כדי להתחיל. שלחו את קוד החדר.':`${roster.length} משתתפים כבר בפנים. אפשר להתחיל כשכולם מוכנים.`} הדירוג של כולם מתחיל ב־<b>1200 Elo</b> עם פתיחת הטורניר.</div>
      ${isHost()?`<form id="settings-form" class="lobby-settings"><div class="settings-heading"><div><strong>הגדרות הטורניר</strong><span>אפשר לשנות עד לתחילת הסיבוב הראשון.</span></div><span class="section-tag">בחירת מארח/ת</span></div>${settingsFields(s,'settings-form')}<button type="submit" class="btn btn-small" ${state.busy?'disabled':''}>שמירת ההגדרות</button></form>`:`<div class="lobby-settings read-only-settings"><div class="settings-heading"><div><strong>הגדרות שנבחרו</strong><span>המארח/ת קובע/ת לפני תחילת הטורניר.</span></div></div><div class="settings-summary"><span><b>סיבובים</b>${esc(roundsLabel(t))}</span><span><b>שעון</b>${esc(timeLabel(s.timePerPlayerSec))}</span></div></div>`}
      <div class="start-tourney-row"><p>${isHost()?'כמארח/ת, אפשר להתחיל כשהחדר מוכן.':'ממתינים ל־'+esc(player(t.hostId)?.name||'מארח/ת')+' שיתחיל/תתחיל את הטורניר.'}</p>${isHost()?`<div class="lobby-host-actions"><button class="btn btn-primary" data-action="start" ${roster.length<2||state.busy?'disabled':''}>התחלת הטורניר <span>←</span></button><button class="btn btn-small btn-danger" data-action="finish-confirm">סגירת החדר</button></div>`:`<span class="status-pill waiting">ממתינים למארח/ת</span>`}</div>
    </section>
    <aside class="card format-card"><div class="section-head"><div><h2 class="section-title">סולם חדש לכל אירוע</h2><p class="section-note">הכללים לפני ההטלה הראשונה.</p></div><span class="section-tag">פורמט החדר</span></div>
      <div class="format-stat"><span class="format-icon">↔</span><span class="format-copy"><strong>צימודים שווייצריים</strong><span>שחקנים עם ניקוד קרוב נפגשים. מנסים להימנע ממפגש חוזר מול אותו יריב.</span></span></div>
      <div class="format-stat"><span class="format-icon">∞</span><span class="format-copy"><strong>אף אחד לא מודח</strong><span>כולם ממשיכים לשחק; בסיבוב עם מספר אי־זוגי של משתתפים מוענק ביי של חצי נקודה.</span></span></div>
      <div class="format-stat"><span class="format-icon">◎</span><span class="format-copy"><strong>Elo ששייך רק לטורניר</strong><span>כולם מתחילים ב־1200. התוצאות משנות את הדירוג באירוע הזה בלבד.</span></span></div>
      <div class="format-stat"><span class="format-icon">♙</span><span class="format-copy"><strong>שש־בש בלי קוביית הכפלה</strong><span>השרת מאמת כל מהלך. ניצחון רגיל, מארס ובקגמון מנוקדים לפי מצב הלוח.</span></span></div>
      <button class="btn btn-small" style="width:100%;margin-top:6px" data-action="rules">קריאת חוקי המשחק</button>
    </aside>
  </div></main>`;
}
function renderDashboardTabs() {
  const matches=currentMatches(),historyCount=allMatches().filter(match=>match.status==='complete'&&match.result&&!match.result.bye&&!match.result.void).length;
  const tabs=[
    {key:'overview',label:'סקירה',icon:'◉'},
    {key:'standings',label:'טבלת דירוג',icon:'☷',count:state.tournament.players.length},
    {key:'games',label:'משחקים חיים',icon:'♙',count:matches.filter(match=>match.status==='live').length},
    {key:'history',label:'היסטוריית משחקים',icon:'↶',count:historyCount}
  ];
  if(!tabs.some(tab=>tab.key===state.dashboardTab)) state.dashboardTab='overview';
  return `<section class="dashboard-toolbar" aria-label="תצוגות הטורניר">
    <div class="toolbar-caption"><span class="toolbar-eyebrow">לוח הטורניר</span><strong>תצוגה לקהל</strong></div>
    <div class="dashboard-tabs" role="tablist" aria-label="בחירת תצוגת הטורניר">${tabs.map(tab=>`<button class="dashboard-tab ${state.dashboardTab===tab.key?'active':''}" id="tab-${tab.key}" type="button" role="tab" aria-selected="${state.dashboardTab===tab.key}" aria-controls="dashboard-panel" tabindex="${state.dashboardTab===tab.key?'0':'-1'}" data-action="dashboard-tab" data-tab="${tab.key}"><span class="tab-icon" aria-hidden="true">${tab.icon}</span><span class="tab-label">${tab.label}</span>${tab.count!==undefined?`<span class="tab-count">${tab.count}</span>`:''}</button>`).join('')}</div>
    <button class="presentation-toggle ${state.presentation?'is-on':''}" type="button" data-action="toggle-presentation" aria-pressed="${state.presentation}" title="הגדלת התצוגה והקרנה במסך מלא"><span aria-hidden="true">${state.presentation?'⤢':'⛶'}</span><span>${state.presentation?'יציאה מתצוגת מקרן':'תצוגת מקרן'}</span></button>
  </section>`;
}
function renderDashboard() {
  const match=currentMatch(),bye=currentMatches().find(item=>item.p1===state.viewerId&&!item.p2);
  const watched=currentMatches().find(item=>item.id===state.watchedMatchId&&item.status==='live');
  const shown=watched||match,game=shown?state.games[shown.id]:null,spectating=!!shown&&shown.id!==match?.id;
  const tab=state.dashboardTab;
  let content;
  if(tab==='standings') content=`<div class="projection-content projection-standings">${renderStandings()}</div>`;
  else if(tab==='games') content=`<div class="projection-content projection-games">${renderLiveTables()}</div>`;
  else if(tab==='history') content=`<div class="projection-content projection-history">${renderHistory()}</div>`;
  else content=`<div class="dashboard-grid"><div class="main-column">${shown?renderGameCard(shown,game,spectating):bye?renderBye(bye):renderSpectator()}<div class="lower-grid">${renderHistory()}${renderRoundAction(match,bye)}</div></div><aside class="side-column">${renderStandings()}${renderLiveTables()}</aside></div>`;
  return `<main class="page-wrap dashboard-page">${renderEventHeading()}${renderDashboardTabs()}<div class="dashboard-panel" id="dashboard-panel" role="tabpanel" tabindex="0" aria-labelledby="tab-${tab}">${content}</div></main>`;
}
function renderBye(bye) {
  return `<section class="card section-card bye-card"><div class="event-kicker">סיבוב ${String(bye.round).padStart(2,'0')} · ביי</div><h2>הפוגה קטנה בין המשחקים.</h2><p>קיבלת ביי של חצי נקודת טורניר. נשארים בסולם ומצטרפים שוב לצימוד בסיבוב הבא.</p><div class="empty-state">אין הדחות. ממתינים לסיום המשחקים בשאר השולחנות.</div></section>`;
}
function renderSpectator() {
  return `<section class="card section-card bye-card"><div class="event-kicker">צפייה בחדר</div><h2>עוקבים אחרי הטורניר.</h2><p>ההצטרפות נסגרת אחרי תחילת הסיבוב הראשון. אפשר לצפות בדירוג, בתוצאות השולחנות ובהתקדמות הטורניר.</p></section>`;
}
function gameClockSeconds(game,side) {
  const saved=game.clockRemaining?.[side];
  if(saved===null||saved===undefined) return null;
  let remaining=Number(saved);
  if(game.clockRunning&&game.turn===side&&!game.over) {
    const estimatedServerNow=Date.now()+state.serverOffset;
    remaining-=Math.max(0,(estimatedServerNow-Number(game.serverNow||estimatedServerNow))/1000);
  }
  return Math.max(0,remaining);
}
function formatClock(seconds) {
  if(seconds===null) return 'ללא הגבלה';
  const total=Math.max(0,Math.ceil(seconds));
  const h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function clockChip(game,side,matchId) {
  const active=game.clockRunning&&game.turn===side&&!game.over;
  const seconds=gameClockSeconds(game,side);
  const cls=`clock-chip ${active?'active':''} ${seconds!==null&&seconds<=30?'low':''}`;
  return `<span class="${cls}" data-clock-chip="${esc(matchId)}-${side}"><small>${active?'השעון רץ':'זמן'}</small><strong data-clock-side="${side}" data-clock-match="${esc(matchId)}">${esc(formatClock(seconds))}</strong></span>`;
}
function updateClockDisplay() {
  document.querySelectorAll('[data-clock-side][data-clock-match]').forEach(element=>{
    const game=state.games[element.dataset.clockMatch];
    if(!game) return;
    const side=element.dataset.clockSide,seconds=gameClockSeconds(game,side),chip=element.closest('.clock-chip');
    element.textContent=formatClock(seconds);
    if(chip) {
      const active=game.clockRunning&&game.turn===side&&!game.over;
      chip.classList.toggle('active',active);
      chip.classList.toggle('low',seconds!==null&&seconds<=30);
      const caption=chip.querySelector('small');
      if(caption) caption.textContent=active?'השעון רץ':'זמן';
    }
  });
}
function renderGameCard(match,game,spectating=false) {
  if(!game) return `<section class="card game-card"><div class="empty-state">מסנכרנים את מצב השולחן. הוא יופיע כאן בעוד רגע.</div></section>`;
  const seated=match.p1===state.viewerId||match.p2===state.viewerId;
  const mySide=seated?game.mySide:null,leftSide=seated?mySide:'w',rightSide=leftSide==='w'?'b':'w';
  const leftPlayer=player(leftSide==='w'?game.whiteId:game.blackId),rightPlayer=player(rightSide==='w'?game.whiteId:game.blackId);
  const myTurn=!!mySide&&game.turn===mySide&&!game.over,playable=myTurn&&!state.busy;
  const legal=playable&&game.rolled?game.legalMoves||[]:[];
  const leftOff=game.board.off[leftSide],rightOff=game.board.off[rightSide];
  const leftPips=pipCount(game.board,leftSide),rightPips=pipCount(game.board,rightSide);
  const leftTag=seated&&leftSide===mySide?'את/ה':leftSide==='w'?'בהיר':'כהה';
  const rightTag=seated&&rightSide===mySide?'את/ה':rightSide==='w'?'בהיר':'כהה';
  const status=game.void?'המשחק בוטל':game.over?'המשחק הסתיים':spectating?'צפייה בשולחן':!game.opening&&myTurn?'התור שלך':game.turn?'תור היריב':'מוכנים להטלה';
  const statusClass=game.over?'done':game.opening?'waiting':'';
  const diceLabel=game.over?'המשחק הסתיים':game.opening?'הטלה פותחת':game.rolled?`${Math.max(0,game.turnMaxMoves-game.movesPlayed)} מהלכים נותרו`:'ממתינים להטלה';
  const canRoll=seated&&!game.over&&!state.busy&&((game.opening&&!game.rolled)||(myTurn&&!game.rolled));
  const last=game.moveLog?.length?game.moveLog[game.moveLog.length-1]:null;
  const lastText=last?`${last.name} · ${formatMove(last.from,last.to)}${last.hit?' · פגיעה':''}`:'עדיין לא בוצעו מהלכים.';
  const barText=seated?`${game.board.bar[mySide]} / ${game.board.bar[mySide==='w'?'b':'w']}`:`${game.board.bar.w} / ${game.board.bar.b}`;
  const caption=game.void?'המשחק בוטל בסיום הטורניר; אין לו השפעה על הניקוד או על Elo.':game.opening?'כל צד מטיל קובייה אחת; הגבוה מתחיל ומשחק בשתי התוצאות.':game.over?`${esc(nameOf(game.winnerId))} ניצח/ה במשחק · ${game.finalScore?.scorePoints||1} נקודות משחק.`:game.rolled?myTurn?'בחר/י כלי ואז נקודת יעד מוארת.':`ממתינים ל־${esc(game.turnPlayerId?nameOf(game.turnPlayerId):'היריב/ה')} לבצע מהלך.`:myTurn?'התור שלך — מטילים לפני שמזיזים.':'היריב/ה בתור; הלוח מתעדכן בזמן אמת.';
  return `<section class="card game-card" aria-label="שולחן שש־בש" data-match-id="${esc(match.id)}">
    <div class="game-card-head"><div class="table-meta"><span class="eyebrow">סיבוב ${String(match.round).padStart(2,'0')} · שולחן ${String(match.table).padStart(2,'0')}</span><span class="eyebrow game-mode-label">משחק יחיד · ללא קוביית הכפלה</span></div><div class="game-head-actions">${spectating?'<button class="subtle-link" data-action="return-my-table">חזרה לשולחן שלי</button>':''}<span class="status-pill ${statusClass}">${!game.over?'<span class="live-dot"></span>':''}${esc(status)}</span></div></div>
    <div class="duelbar"><div class="duel-player"><span class="player-avatar">${esc(initials(leftPlayer?.name||'בהיר'))}</span><div class="player-ident"><strong><bdi>${esc(leftPlayer?.name||'בהיר')}</bdi> <span class="player-side-label">${leftTag}</span></strong><span><em class="t-elo">${leftPlayer?.elo??1200} Elo לטורניר</em></span><div class="player-mini-state"><span class="pip-dot"></span>${leftOff} הוצאו · ${leftPips} פיפים</div></div>${clockChip(game,leftSide,match.id)}</div><div class="versus">נגד</div><div class="duel-player opponent"><div class="player-ident"><strong><bdi>${esc(rightPlayer?.name||'כהה')}</bdi> <span class="player-side-label">${rightTag}</span></strong><span><em class="t-elo">${rightPlayer?.elo??1200} Elo לטורניר</em></span><div class="player-mini-state"><span class="pip-dot"></span>${rightOff} הוצאו · ${rightPips} פיפים</div></div>${clockChip(game,rightSide,match.id)}<span class="player-avatar opponent">${esc(initials(rightPlayer?.name||'כהה'))}</span></div></div>
    <div class="game-status-line"><div class="game-message"><bdi>${esc(game.message||'')}</bdi></div><div class="game-mini-stats"><span>בבר <strong>${barText}</strong></span></div></div>
    ${renderBoard(game,legal)}
    <div class="dice-control-row"><div class="dice-info"><div class="dice-faces" aria-label="קוביות">${renderDice(game.diceShown)}</div><div class="dice-caption"><strong>${esc(diceLabel)}</strong><span>${caption}</span></div></div>
      <div class="game-controls"><button class="btn btn-primary" data-action="roll" ${canRoll?'':'disabled'}>${game.opening?'הטלה פותחת':game.rolled?'הקוביות הוטלו':'הטלת קוביות'} <span>↖</span></button><button class="btn btn-small" data-action="undo" ${game.undoAvailable&&playable?'':'disabled'} title="ביטול המהלך האחרון">↶ <span>ביטול</span></button><button class="btn btn-small btn-icon" data-action="rules" title="חוקי המשחק" aria-label="חוקי שש־בש">?</button></div>
    </div>
    <div class="game-card-foot"><div class="turn-nudge"><span class="turn-marker">${game.turn?(myTurn?'●':'◌'):'↖'}</span><span><b>${game.turn?(myTurn?'התור שלך':`${esc(game.turnPlayerId?nameOf(game.turnPlayerId):'היריב/ה')} בתור`):'הטלה פותחת'}</b> · ${game.rolled?`${game.movesPlayed}/${game.turnMaxMoves} מהלכים בוצעו`:'יש לשחק את כל הקוביות החוקיות'}</span></div><div class="move-log" title="המהלך האחרון">${esc(lastText)}</div></div>
  </section>`;
}
function renderBoard(game,legal) {
  const next=legal||[],sources=new Set(next.map(move=>String(move.from)));
  const targets=new Set(state.selectedFrom!==null?next.filter(move=>String(move.from)===String(state.selectedFrom)).map(move=>String(move.to)):[]);
  const arrays={topLeft:[23,22,21,20,19,18],topRight:[17,16,15,14,13,12],bottomLeft:[0,1,2,3,4,5],bottomRight:[6,7,8,9,10,11]};
  const pointHtml=(index,orientation)=>{
    const point=game.board.points[index],count=point.w+point.b,side=point.w?'w':point.b?'b':null;
    const source=sources.has(String(index)),target=targets.has(String(index)),visible=Math.min(count,5);
    const checkers=Array.from({length:visible},(_,i)=>`<span class="checker ${side==='w'?'white':'black'}" style="--step:${i}">${count>=5&&i===visible-1?`<b class="checker-count">${count}</b>`:''}</span>`).join('');
    const label=`נקודה ${index+1}${count?`, ${count} כלים ${side==='w'?'בהירים':'כהים'}`:''}${target?', יעד חוקי':''}`;
    return `<button type="button" class="point ${orientation} ${source?'is-source':''} ${target?'is-target':''}" data-point="${index}" aria-label="${esc(label)}"><span class="point-label">${index+1}</span>${target?'<span class="target-mark"></span>':''}${visible?`<span class="checker-stack">${checkers}</span>`:''}</button>`;
  };
  const row=(list,orientation)=>list.map(index=>pointHtml(index,orientation)).join('');
  const barSlot=side=>{
    const count=game.board.bar[side],source=sources.has('bar')&&side===game.mySide;
    return `<button class="bar-slot ${count?'has-checkers':''} ${source?'is-source':''}" data-bar="${side}" aria-label="הבר של הצד ${side==='w'?'הבהיר':'הכהה'}, ${count} כלים">${count?`<span class="bar-checker ${side==='w'?'white':'black'}">${count>1?count:''}</span>`:''}</button>`;
  };
  const targetOff=targets.has('off'),whiteTarget=targetOff&&game.mySide==='w',blackTarget=targetOff&&game.mySide==='b';
  return `<div class="board-stage"><div class="board-frame"><div class="board-surface" id="boardSurface" dir="ltr"><div class="board-half top left">${row(arrays.topLeft,'top')}</div><div class="board-half top right">${row(arrays.topRight,'top')}</div><div class="board-center">${barSlot('b')}${barSlot('w')}</div><div class="board-half bottom left">${row(arrays.bottomLeft,'bottom')}</div><div class="board-half bottom right">${row(arrays.bottomRight,'bottom')}</div></div></div><div class="off-tray"><button class="off-slot opponent ${blackTarget?'is-target':''}" data-dest="off" data-off-side="b" aria-disabled="${game.mySide!=='b'||game.over}" aria-label="כלים כהים שהוצאו ${game.board.off.b}" ${game.mySide==='b'?'':'tabindex="-1"'}><small>כהים · בחוץ</small><strong>${game.board.off.b}</strong><span class="off-mark">${blackTarget?'↖':'כ'}</span><span class="off-progress"><i style="width:${game.board.off.b/15*100}%"></i></span></button><button class="off-slot ${whiteTarget?'is-target':''}" data-dest="off" data-off-side="w" aria-disabled="${game.mySide!=='w'||game.over}" aria-label="כלים בהירים שהוצאו ${game.board.off.w}" ${game.mySide==='w'?'':'tabindex="-1"'}><small>בהירים · בחוץ</small><strong>${game.board.off.w}</strong><span class="off-mark">${whiteTarget?'↖':'ב'}</span><span class="off-progress"><i style="width:${game.board.off.w/15*100}%"></i></span></button></div></div>`;
}
function renderDice(values) {
  if(!values?.length) return '<span class="die-face empty" aria-hidden="true"></span><span class="die-face empty" aria-hidden="true"></span>';
  return values.slice(0,2).map((value,index)=>`<span class="die-face" aria-label="קובייה ${index+1}: ${value}">${Array.from({length:9},(_,i)=>`<i class="die-pip ${PIPS[value]?.includes(i+1)?'on':''}"></i>`).join('')}</span>`).join('');
}
function renderStandings() {
  const rows=standings(),early=state.tournament.finishReason==='host-early';
  return `<section class="card side-card standings-card"><div class="standings-topline"><h2 class="section-title">טבלת הדירוג</h2><span class="live-count"><span class="live-dot"></span> ELO לטורניר</span></div><p class="standings-subtitle">הדירוג מתעדכן לפי תוצאות המשחקים שהסתיימו.</p><div class="standings-head"><span>#</span><span>שחקן/ית</span><span>נ׳ / ה׳ / נק׳</span><span>Elo</span></div>${rows.map(person=>`<div class="standing-row ${person.id===state.viewerId?'you':''}"><span class="standing-rank">${String(person.rank).padStart(2,'0')}</span><span class="standing-name-wrap"><span class="mini-avatar">${esc(initials(person.name))}</span><span class="standing-name"><bdi>${esc(person.name)}</bdi>${person.id===state.viewerId?'<small>את/ה</small>':''}</span></span><span class="standing-record">${person.wins} / ${person.losses} / ${fmtPoints(person.points)}</span><span class="standing-elo">${person.elo}</span></div>`).join('')}<div class="ladder-key">נ׳ = ניצחונות · ה׳ = הפסדים · נק׳ = נקודות טורניר.${early?' בסיום מוקדם: הנקודות קודמות, ו־Elo משמש שובר שוויון לפני בוכהולץ.':' כל טורניר מתחיל מחדש ב־1200 Elo.'}</div></section>`;
}
function renderLiveTables() {
  const matches=currentMatches(),live=matches.filter(match=>match.status==='live').length;
  return `<section class="card side-card live-card"><div class="section-head"><div><h2 class="section-title">מה קורה בחדר?</h2><p class="section-note">סיבוב ${state.tournament.currentRound} · ${matches.length} שולחנות</p></div><span class="section-tag">${live} בשידור</span></div><div class="table-list">${matches.map(match=>{
    const a=player(match.p1),b=player(match.p2),isMine=match.p1===state.viewerId||match.p2===state.viewerId,selected=state.watchedMatchId===match.id;
    const status=match.status==='complete'?'הסתיים':match.status==='void'?'בוטל':'חי';
    const score=match.result?.bye?'ביי':match.result?.void?'—':match.status==='complete'?(match.result?.winnerId===match.p1?`${match.result.scorePoints||1}–0`:`0–${match.result?.scorePoints||1}`):'מול';
    const tag=match.status==='live'?'button':'div';
    const attrs=match.status==='live'?`type="button" data-action="watch-match" data-match-id="${esc(match.id)}" aria-label="${isMine?'חזרה לשולחן שלך':'צפייה בשולחן'} ${match.table}"`:'';
    return `<${tag} class="table-item ${isMine?'your-table':''} ${selected?'selected-table':''} ${match.status==='void'?'void-table':''}" ${attrs}><div class="table-item-top"><span class="table-num">שולחן ${String(match.table).padStart(2,'0')}${isMine?' · המושב שלך':selected?' · בצפייה':''}</span><span class="table-status ${match.status==='complete'?'finished':''} ${match.status==='void'?'waiting':''}">${match.status==='live'?'<span class="live-dot"></span>':''}${status}</span></div><div class="table-players"><span class="player-short"><bdi>${esc(a?.name||'ממתינים')}</bdi></span><span class="tiny-score">${esc(score)}</span><span class="player-short"><bdi>${esc(b?.name||'')}</bdi></span></div><div class="table-item-foot"><span>${a?.elo??'—'} Elo</span><span>${b?.elo??'—'} Elo</span></div></${tag}>`;
  }).join('')}</div><div class="live-card-actions"><p class="games-foot">המשחקים החיים מתעדכנים עם כל הטלה ומהלך. תוצאה נרשמת מיד עם סיום המשחק.</p><button class="btn btn-small btn-quiet" data-action="copy-view">העתקת קישור לצפייה בלבד</button></div></section>`;
}
function allMatches() { return (state.tournament?.rounds||[]).flatMap(round=>round.matches); }
function renderHistory() {
  const results=allMatches().filter(match=>match.status==='complete'&&match.result&&!match.result.bye&&!match.result.void).sort((a,b)=>b.round-a.round||b.table-a.table);
  const recent=results;
  return `<section class="card section-card"><div class="section-head"><div><h2 class="section-title">היסטוריית הטורניר</h2><p class="section-note">כל המשחקים שהסתיימו, מהחדש לישן</p></div><span class="section-tag">${results.length} תוצאות</span></div>${recent.length?`<div class="history-list">${recent.map(match=>{const winner=player(match.result.winnerId),loser=player(match.result.loserId);return `<div class="history-row"><span class="history-round">ס${String(match.round).padStart(2,'0')} · ש${String(match.table).padStart(2,'0')}</span><span class="history-names"><span class="winner"><bdi>${esc(winner?.name||'מנצח/ת')}</bdi></span><span class="history-separator"> ניצח/ה את </span><span class="loser"><bdi>${esc(loser?.name||'יריב/ה')}</bdi></span></span><span class="history-score">${match.result.scorePoints||1}–0</span></div>`;}).join('')}</div>`:'<div class="empty-state">הקוביות עוד מחכות.<br>משחקים שהסתיימו יופיעו כאן.</div>'}</section>`;
}
function renderRoundAction(match,bye) {
  const t=state.tournament,r=currentRound(),matches=r?.matches||[],unfinished=matches.filter(item=>item.status==='live');
  if(match&&match.status==='live') return `<section class="card round-action-card"><span class="eyebrow">השולחן שלך</span><h3>המשחק מחכה לך.</h3><p>השרת בודק את התור ואת המהלכים החוקיים. כשהשולחנות יסתיימו, המארח/ת יפתח/תפתח את הסיבוב הבא.</p><button class="btn btn-primary" data-action="scroll-board">חזרה ללוח <span>↑</span></button><p class="small-print">בלי חשבונות. דירוג ה־Elo נשאר בטורניר הזה בלבד.</p></section>`;
  if(unfinished.length) return `<section class="card round-action-card"><span class="eyebrow">הסיבוב עדיין מתנהל</span><h3>${bye?'הביי שלך כבר נרשם.':'המשחק שלך הסתיים.'}</h3><p>נותרו ${unfinished.length} שולחנות. אחרי סיום כולם, ${isHost()?'אפשר לפתוח':'המארח/ת יפתח/תפתח'} את הסיבוב השווייצרי הבא.</p><button class="btn" data-action="scroll-tables">צפייה בשולחנות החיים <span>↓</span></button><p class="small-print">אף משתתף/ת לא מודח/ת.</p></section>`;
  const hasNext=t.settings?.unlimitedRounds||t.currentRound<t.totalRounds;
  if(hasNext&&isHost()) return `<section class="card round-action-card"><span class="eyebrow">סיבוב ${String(t.currentRound).padStart(2,'0')} הושלם</span><h3>מצמידים מחדש.</h3><p>הצימודים מתחשבים בנקודות ובדירוג Elo. מנסים להימנע ממפגש חוזר מול אותו יריב.</p><button class="btn btn-primary" data-action="next-round" ${state.busy?'disabled':''}>פתיחת סיבוב ${t.currentRound+1} <span>←</span></button><p class="small-print">${t.settings?.unlimitedRounds?'הטורניר ממשיך עד שהמארח/ת יסיים/תסיים.':'כולם משתתפים בכל הסיבובים.'}</p></section>`;
  if(hasNext) return `<section class="card round-action-card"><span class="eyebrow">סיבוב ${String(t.currentRound).padStart(2,'0')} הושלם</span><h3>ממתינים למארח/ת.</h3><p>כל השולחנות הסתיימו. ${esc(player(t.hostId)?.name||'המארח/ת')} יפתח/תפתח את הצימוד הבא.</p><div class="waiting-note">כולם נשארים במשחק. דירוג ה־Elo מתעדכן רק בתוך האירוע.</div></section>`;
  return `<section class="card round-action-card"><span class="eyebrow">הסיבוב האחרון הושלם</span><h3>הדירוג הסופי מוכן.</h3><p>כל המשחקים המתוכננים הסתיימו. התוצאות והדירוג שייכים לחדר הזה בלבד.</p><button class="btn btn-gold" data-action="show-final">לתוצאות הטורניר <span>✦</span></button></section>`;
}
function finalSummaryText(t) {
  if(t.finishReason==='host-early') {
    const summary=t.earlyFinishSummary||{};
    if(!(summary.roundsStarted||t.currentRound)) return 'החדר נסגר לפני שהתחילו המשחקים. לא נקבע מנצח/ת רשמי/ת.';
    return `הטורניר הסתיים ביוזמת המארח/ת אחרי סיבוב ${summary.roundsStarted||t.currentRound}. ${summary.completedTables||0} משחקים הושלמו ו־${summary.voidedGames||0} משחקים לא גמורים בוטלו.`;
  }
  return `כל ${t.totalRounds||t.currentRound} הסיבובים המתוכננים הושלמו. ${t.players.length} שחקנים השתתפו, ללא הדחות.`;
}
function renderFinalHistory() {
  const records=allMatches().filter(match=>match.result).sort((a,b)=>b.round-a.round||b.table-a.table);
  return `<section class="card final-history-card"><div class="section-head"><div><h2 class="section-title">היסטוריית כל השולחנות</h2><p class="section-note">תוצאות שהושלמו, ביי ושולחנות שבוטלו</p></div><span class="section-tag">${records.length} רשומות</span></div>${records.length?`<div class="final-history-list">${records.map(match=>{
    const tableLabel=`סיבוב ${String(match.round).padStart(2,'0')} · שולחן ${String(match.table).padStart(2,'0')}`;
    if(match.result.bye) return `<div class="final-history-row"><span class="history-round">${tableLabel}</span><span class="history-names"><bdi>${esc(player(match.p1)?.name||'שחקן/ית')}</bdi> קיבל/ה ביי</span><span class="history-score">+0.5 נק׳</span></div>`;
    if(match.result.void) return `<div class="final-history-row void"><span class="history-round">${tableLabel}</span><span class="history-names"><bdi>${esc(player(match.p1)?.name||'שחקן/ית')}</bdi> · <bdi>${esc(player(match.p2)?.name||'שחקן/ית')}</bdi></span><span class="history-score">בוטל · לא נספר</span></div>`;
    const winner=player(match.result.winnerId),loser=player(match.result.loserId),reason=match.result.reason==='time'?' · על זמן':'';
    return `<div class="final-history-row"><span class="history-round">${tableLabel}</span><span class="history-names"><bdi class="winner">${esc(winner?.name||'מנצח/ת')}</bdi> ניצח/ה את <bdi class="loser">${esc(loser?.name||'יריב/ה')}</bdi>${reason}</span><span class="history-score">${match.result.scorePoints||1}–0</span></div>`;
  }).join('')}</div>`:'<div class="empty-state">עדיין אין תוצאות להצגה.</div>'}</section>`;
}
function renderFinal() {
  const t=state.tournament,ranked=standings(),first=ranked[0],second=ranked[1],third=ranked[2];
  const hasCountedResults=allMatches().some(match=>match.status==='complete'&&match.result);
  const early=t.finishReason==='host-early',beforeStart=early&&!(t.earlyFinishSummary?.roundsStarted||t.currentRound);
  const hasEvidence=ranked.some(person=>person.points>0||person.wins>0||person.elo!==1200);
  const pieces=Array.from({length:38},(_,i)=>`<i style="left:${(i*37+11)%100}%;animation-delay:${((i*17)%44)/10}s;animation-duration:${4.4+((i*13)%25)/10}s;transform:rotate(${(i*31)%110}deg)"></i>`).join('');
  const title=beforeStart?'החדר נסגר לפני ההטלה הראשונה.':early&&!hasEvidence?'עדיין אין תוצאה שמצביעה על מוביל/ה.':early?`${esc(first?.name||'הטבלה')} מוביל/ה לפי התוצאות שנספרו.`:`${esc(first?.name||'המנצח/ת')} לוקח/ת את הכתר.`;
  const kicker=early?'סיום מוקדם · תוצאות הטורניר':`${roundsLabel(t)} · התוצאות הסופיות`;
  return `<main class="page-wrap"><section class="final-screen ${early?'early-final':''}"><div class="confetti">${pieces}</div><div class="final-kicker">${esc(t.name)} · ${esc(kicker)}</div><div class="final-title-row"><h1>${early?'הטורניר הסתיים.':`המהלך האחרון הושלם.`}<br><em>${title}</em></h1><p>${esc(finalSummaryText(t))} דירוג Elo של כל משתתף/ת התחיל ב־1200 ונשאר בחדר הזה.</p></div>
    ${hasCountedResults?`<div class="podium">${podium(second,2,early)}${podium(first,1,early)}${podium(third,3,early)}</div>`:`<div class="no-podium-note">${beforeStart?'לא נערכו משחקים ולכן אין מנצח/ת רשמי/ת.':`לא הושלמו תוצאות שנספרות. אין מוביל/ה מוכרע/ת בשלב זה.`}</div>`}
    ${early?`<div class="early-rule-note"><strong>איך נקבע הדירוג בסיום מוקדם?</strong><span>רק משחקים שהסתיימו וביי שכבר הוענקו נספרים. משחקים שהיו עדיין בתהליך בוטלו — ללא נקודות, ניצחון או השפעה על Elo. הדירוג נקבע לפי נקודות טורניר, אחר כך Elo, אחר כך בוכהולץ (סכום נקודות היריבים) ולבסוף מספר ניצחונות. Elo משתנה רק בעקבות משחקים שהושלמו.</span></div>`:''}
    <div class="final-lower"><section class="final-table-card"><div class="section-head"><div><h2 class="section-title">${early?'דירוג בסיום מוקדם':'הדירוג הסופי'}</h2><p class="section-note">${early?'נקודות · Elo · בוכהולץ · ניצחונות':'נקודות · ניצחונות · בוכהולץ · Elo'}</p></div><span class="section-tag">${t.players.length} משתתפים</span></div>${ranked.map(person=>`<div class="final-row"><span class="rank">${String(person.rank).padStart(2,'0')}</span><span class="name"><bdi>${esc(person.name)}</bdi>${person.id===state.viewerId?' <span class="you-tag">את/ה</span>':''}</span><span class="record">${person.wins} נ׳–${person.losses} ה׳ · ${fmtPoints(person.points)} נק׳</span><span class="elo">${person.elo}</span></div>`).join('')}</section><section class="share-card"><div class="section-head"><div><h2 class="section-title">לוקחים את התוצאה הלאה</h2><p class="section-note">שתפו את טבלת החדר.</p></div><span class="share-star">✦</span></div><p class="share-copy">${esc(beforeStart?'החדר נסגר לפני תחילת המשחקים.':`${first?.name||'המוביל/ה'} מוביל/ה בטורניר ${t.name} עם ${fmtPoints(first?.points)} נקודות.`)} ${t.players.length} משתתפים.</p><div class="share-actions"><button class="btn btn-small" data-action="share" data-platform="x">𝕏&nbsp; פרסום</button><button class="btn btn-small" data-action="share" data-platform="whatsapp">WhatsApp</button><button class="btn btn-small" data-action="share" data-platform="facebook">Facebook</button><button class="btn btn-small" data-action="share" data-platform="linkedin">LinkedIn</button><button class="btn btn-small" data-action="share" data-platform="copy">העתקת תוצאה</button></div></section></div>${renderFinalHistory()}<div class="final-bottom"><small>הדירוג שייך לחדר הזה. בטורניר חדש כולם מתחילים שוב ב־1200 Elo.</small><button class="btn btn-primary" data-action="host">פתיחת טורניר חדש <span>↖</span></button></div></section></main>`;
}
function podium(person,place,early=false) {
  const cls=place===1?'first':place===2?'second':'third';
  const rankText=early?`מקום ${place} · תוצאות שנחשבו`:place===1?'מקום ראשון':place===2?'מקום שני':'מקום שלישי';
  if(!person) return `<div class="podium-place ${cls}"><div class="podium-rank">${rankText}</div><h2>—</h2><p>אין תוצאה</p><div class="podium-points">—</div><div class="podium-base">${String(place).padStart(2,'0')}</div></div>`;
  return `<div class="podium-place ${cls}"><span class="podium-crown">${place===1?'<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="m4 8 4.5 4 3.5-7 3.5 7L20 8l-1.5 10h-13L4 8Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6 21h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>':place}</span><div class="podium-rank">${rankText}</div><h2><bdi>${esc(person.name)}</bdi></h2><p>${person.wins} ניצחונות · ${person.elo} Elo</p><div class="podium-points">${fmtPoints(person.points)} נק׳</div><div class="podium-base">${String(place).padStart(2,'0')}</div></div>`;
}
function renderModalMarkup() {
  const modal=state.modal;
  if(!modal) return '';
  if(modal.type==='host') return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="hostTitle"><div class="modal-head"><div><div class="eyebrow">טורניר חדש</div><h2 id="hostTitle">פותחים חדר חדש.</h2><p>בלי חשבון ובלי דירוג ישן. כל המשתתפים מתחילים באירוע הזה ב־1200 Elo.</p></div><button class="modal-close" data-action="close-modal" aria-label="סגירה">×</button></div><form id="host-form"><div class="modal-grid"><div class="modal-field full"><label class="field-label" for="tournamentName">שם הטורניר</label><input class="text-input" id="tournamentName" name="name" maxlength="34" placeholder="לדוגמה: ליל שיש־בש אצלנו" required></div><div class="modal-field full"><label class="field-label" for="hostName">השם שיופיע בחדר</label><input class="text-input" id="hostName" name="hostName" maxlength="24" placeholder="השם שלך" required></div></div><div class="host-settings-block"><div class="settings-heading"><div><strong>הגדרות לפני הפתיחה</strong><span>אפשר לשנות אותן שוב בלובי עד שמתחילים.</span></div></div>${settingsFields({rounds:5,unlimitedRounds:false,timePerPlayerSec:0},'host-form')}</div><p class="modal-help">משתתפים מצטרפים עם קוד ושם בלבד. אין הרשמה, חשבונות או דירוג Elo שנשמר בין טורנירים.</p><div class="modal-actions"><button type="button" class="btn btn-quiet" data-action="close-modal">ביטול</button><button type="submit" class="btn btn-primary">יצירת חדר <span>←</span></button></div></form></section></div>`;
  if(modal.type==='join') return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="joinTitle"><div class="modal-head"><div><div class="eyebrow">מקום פנוי ליד הלוח</div><h2 id="joinTitle">מצטרפים לטורניר.</h2><p>מזינים את קוד החדר ואת השם שיופיע בטבלת הדירוג.</p></div><button class="modal-close" data-action="close-modal" aria-label="סגירה">×</button></div><form id="join-form"><div class="modal-field" style="margin-bottom:12px"><label class="field-label" for="joinCode">קוד החדר</label><input class="text-input join-code" id="joinCode" name="code" maxlength="14" placeholder="PIP-7K2M9A" value="${esc(modal.code||'')}" required autocomplete="off" dir="ltr"></div><div class="modal-field"><label class="field-label" for="joinName">השם שלך בטורניר</label><input class="text-input" id="joinName" name="name" maxlength="24" placeholder="השם שיופיע בלוח" required></div><p class="modal-help">שם אחד לכל חדר. הדירוג שלך מתחיל ב־1200 ונשאר בתוך הטורניר הזה.</p><div class="modal-actions"><button type="button" class="btn btn-quiet" data-action="close-modal">ביטול</button><button type="submit" class="btn btn-primary">הצטרפות <span>←</span></button></div></form></section></div>`;
  if(modal.type==='rules') return `<div class="modal-backdrop"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="rulesTitle"><div class="modal-head"><div><div class="eyebrow">חוקי השולחן</div><h2 id="rulesTitle">שש־בש, כמו שצריך.</h2><p>מהלכים חוקיים נבדקים בשרת הטורניר.</p></div><button class="modal-close" data-action="close-modal" aria-label="סגירה">×</button></div><div class="rules-list">${[
    ['הטלה פותחת','כל צד מטיל קובייה אחת. הגבוה מתחיל ומשחק בשתי התוצאות; בשוויון מטילים שוב. בתור רגיל, זוג זהה נותן ארבעה מהלכים.'],
    ['תנועה, חסימה ופגיעה','מתקדמים לעבר הבית. נקודה עם שני כלים יריבים או יותר חסומה. נחיתה על כלי בודד פוגעת בו ומחזירה אותו לבר.'],
    ['הבר קודם לכל','כשיש כלי על הבר חייבים להכניס אותו לפני שמזיזים כלי אחר. נקודת כניסה חסומה מבטלת את השימוש באותה קובייה.'],
    ['משחקים את כל הקוביות החוקיות','השרת מוצא את כל רצפי המהלכים. חייבים לשחק כמה שיותר קוביות; אם אפשר לשחק רק אחת משתי קוביות שונות, משחקים את הגבוהה כשאפשר.'],
    ['הוצאה מהלוח','מוציאים רק אחרי שכל 15 הכלים בבית. אפשר להוציא בדיוק; קובייה גבוהה מהנדרש מותרת רק אם אין כלי רחוק יותר מהיציאה.'],
    ['ניקוד בלי קוביית הכפלה','אין הצעת דאבל ואין קוביית הכפלה. ניצחון רגיל שווה נקודת משחק אחת, מארס שווה 2 ובקגמון שווה 3. בטורניר כל ניצחון מעניק נקודה אחת.']
  ].map((rule,index)=>`<div class="rule-row"><span class="rule-num">${String(index+1).padStart(2,'0')}</span><span><strong>${esc(rule[0])}</strong><span>${esc(rule[1])}</span></span></div>`).join('')}</div><div class="modal-actions"><span class="section-note">הצד הבהיר נע לעבר נקודות 1–6; הכהה לעבר 24–19.</span><button class="btn btn-primary" data-action="close-modal">הבנתי</button></div></section></div>`;
  if(modal.type==='finish') {
    const unfinished=allMatches().filter(match=>match.status==='live').length;
    const inLobby=state.tournament?.status==='lobby';
    return `<div class="modal-backdrop"><section class="modal finish-modal" role="dialog" aria-modal="true" aria-labelledby="finishTitle"><div class="modal-head"><div><div class="eyebrow">סיום ביוזמת המארח/ת</div><h2 id="finishTitle">${inLobby?'לסגור את החדר?':'לסיים את הטורניר עכשיו?'}</h2><p>${inLobby?'החדר ייסגר לפני תחילת המשחקים ולא תהיה תוצאה רשמית.':`יש כרגע ${unfinished} שולחנות שעדיין לא הסתיימו.`}</p></div><button class="modal-close" data-action="close-modal" aria-label="סגירה">×</button></div><div class="early-rule-note modal-rule"><strong>איך זה ישפיע על התוצאה?</strong><span>רק משחקים שהסתיימו וביי שכבר הוענקו ייספרו. משחקים שעדיין בתהליך יבוטלו ולא יעניקו נקודות, ניצחון או Elo. הדירוג ייקבע לפי נקודות, אחר כך Elo, אחר כך בוכהולץ (סכום נקודות היריבים) ולבסוף ניצחונות.</span></div><div class="modal-actions"><button class="btn btn-quiet" data-action="close-modal">להמשיך בטורניר</button><button class="btn btn-danger" data-action="finish-tournament">${inLobby?'סגירת החדר':'סיום הטורניר'}</button></div></section></div>`;
  }
  return '';
}
function syncModal() { modalRoot.innerHTML=renderModalMarkup(); }
function render() {
  const t=state.tournament;
  if(!t||t.status!=='live') state.presentation=false;
  document.body.classList.toggle('presentation-mode',state.presentation);
  site.innerHTML=renderHeader()+(t?(t.status==='lobby'?renderLobby():t.status==='complete'?renderFinal():renderDashboard()):renderLanding())+footer();
  syncModal();
  updateClockDisplay();
}
function openHost() { state.modal={type:'host'}; syncModal(); }
function openJoin(code='') { state.modal={type:'join',code}; syncModal(); }
function closeModal() { state.modal=null; syncModal(); }
async function togglePresentation() {
  state.presentation=!state.presentation;
  render();
  if(state.presentation&&document.documentElement?.requestFullscreen) {
    try { await document.documentElement.requestFullscreen(); } catch {}
  } else if(!state.presentation&&document.fullscreenElement&&document.exitFullscreen) {
    try { await document.exitFullscreen(); } catch {}
  }
}
function copyText(text,message) {
  const fallback=()=>{const input=document.createElement('textarea');input.value=text;document.body.appendChild(input);input.select();document.execCommand('copy');input.remove();showToast(message);};
  if(navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(()=>showToast(message)).catch(fallback); else fallback();
}
function inviteUrl() { return `${location.origin}${location.pathname}?room=${encodeURIComponent(state.tournament?.code||'')}`; }
function viewUrl() { return `${location.origin}${location.pathname}?view=${encodeURIComponent(state.tournament?.code||'')}`; }
function shareMessage() {
  const t=state.tournament,top=standings()[0];
  if(t.finishReason==='host-early') {
    const evidence=standings().some(person=>person.points>0||person.wins>0||person.elo!==1200);
    return evidence?`${top?.name||'המוביל/ה'} מוביל/ה בטורניר ${t.name} לפי התוצאות שנספרו.`:`הטורניר ${t.name} הסתיים מוקדם, לפני שנקבע מוביל/ה.`;
  }
  return `${top?.name||'המנצח/ת'} לקח/ה את המקום הראשון בטורניר ${t.name}: ${fmtPoints(top?.points)} נקודות אחרי ${t.totalRounds} סיבובים.`;
}
function share(platform) {
  const message=shareMessage(),url=state.tournament?.status==='complete'?viewUrl():inviteUrl();
  if(platform==='copy') { copyText(`${message}\n${url}`,'התוצאה הועתקה.'); return; }
  const links={
    x:`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}&url=${encodeURIComponent(url)}`,
    whatsapp:`https://wa.me/?text=${encodeURIComponent(message+' '+url)}`,
    facebook:`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(message)}`,
    linkedin:`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`
  };
  if(links[platform]) window.open(links[platform],'_blank','noopener,noreferrer,width=720,height=600');
}
function pipCount(board,side) {
  let count=board.bar[side]*25;
  board.points.forEach((point,index)=>count+=point[side]*(side==='w'?index+1:24-index));
  return count;
}
function formatMove(from,to) { return `${from==='bar'?'בר':Number(from)+1}/${to==='off'?'מחוץ ללוח':Number(to)+1}`; }
function settingsFromForm(formData) {
  const unlimited=formData.get('roundMode')==='unlimited';
  return {rounds:unlimited?'unlimited':Number(formData.get('rounds')||5),unlimitedRounds:unlimited,timePerPlayerSec:Number(formData.get('timePerPlayerSec')||0)};
}
async function createTournament(form) {
  const values=new FormData(form);
  const data=await request('/api/tournaments',{name:values.get('name'),hostName:values.get('hostName'),settings:settingsFromForm(values)});
  state.token=data.token; state.code=data.tournament.code; saveSeat(state.code,state.token); setUrl(state.code);
  closeModal(); setSnapshot(data,true); connectRoom(state.code,state.token);
  showToast(`החדר ${state.code} נפתח. אפשר לשלוח את קישור ההזמנה.`);
}
async function joinTournament(form) {
  const values=new FormData(form),code=normalizeCode(values.get('code')),name=String(values.get('name')||'').trim();
  if(!code||!name) throw new Error('נא להזין קוד חדר ושם שחקן/ית.');
  const data=await request(`${codePath(code)}/join`,{name});
  state.token=data.token; state.code=data.tournament.code; saveSeat(state.code,state.token); setUrl(state.code);
  closeModal(); setSnapshot(data,true); connectRoom(state.code,state.token);
  showToast(`ברוך/ה הבא/ה, ${name}. הצטרפת לסולם הטורניר.`);
}
function returnToRoom(code,token,data) { state.token=token; state.code=code; setSnapshot(data,true); connectRoom(code,token); setUrl(code); }

async function action(name,element,event) {
  switch(name) {
    case 'host': openHost(); break;
    case 'join': openJoin(''); break;
    case 'rules': state.modal={type:'rules'}; syncModal(); break;
    case 'close-modal': closeModal(); break;
    case 'dashboard-tab': if(['overview','standings','games','history'].includes(element.dataset.tab)) { state.dashboardTab=element.dataset.tab; render(); } break;
    case 'toggle-presentation': await togglePresentation(); break;
    case 'copy-code': if(state.tournament) copyText(state.tournament.code,'קוד החדר הועתק.'); break;
    case 'copy-invite': if(state.tournament) copyText(`${state.tournament.name} · מצטרפים עם הקוד ${state.tournament.code}\n${inviteUrl()}`,'קישור ההזמנה הועתק.'); break;
    case 'copy-view': if(state.tournament) copyText(`${state.tournament.name} · קישור צפייה לקריאה בלבד\n${viewUrl()}`,'קישור הצפייה הועתק.'); break;
    case 'settings-save': break;
    case 'start': await roomPost('/start',{},'הטורניר התחיל. בהצלחה ליד הלוח!'); break;
    case 'next-round': await roomPost('/round/next',{},'הסיבוב הבא נפתח.'); break;
    case 'finish-confirm': state.modal={type:'finish'}; syncModal(); break;
    case 'finish-tournament': state.modal=null; syncModal(); await roomPost('/finish',{},'הטורניר הסתיים. התוצאות עודכנו לכל המשתתפים.'); break;
    case 'roll': { const match=currentMatch(); if(match) await roomPost(`/matches/${encodeURIComponent(match.id)}/roll`); break; }
    case 'undo': { const match=currentMatch(); if(match) await roomPost(`/matches/${encodeURIComponent(match.id)}/undo`); break; }
    case 'watch-match': { const own=currentMatch(); state.watchedMatchId=element.dataset.matchId===own?.id?'':element.dataset.matchId; if(!state.watchedMatchId) state.watchedMatchId=null; state.dashboardTab='overview'; state.selectedFrom=null; render(); setTimeout(()=>document.querySelector('.game-card')?.scrollIntoView({behavior:'smooth',block:'center'}),0); break; }
    case 'return-my-table': state.watchedMatchId=null; state.dashboardTab='overview'; state.selectedFrom=null; render(); document.querySelector('.game-card')?.scrollIntoView({behavior:'smooth',block:'center'}); break;
    case 'share': share(element.dataset.platform); break;
    case 'show-final': render(); break;
    case 'scroll-board': document.querySelector('.game-card')?.scrollIntoView({behavior:'smooth',block:'center'}); break;
    case 'scroll-tables': document.querySelector('.live-card')?.scrollIntoView({behavior:'smooth',block:'center'}); break;
    case 'home': event?.preventDefault(); if(state.tournament) window.scrollTo({top:0,behavior:'smooth'}); else {state.modal=null;render();} break;
  }
}
async function handleBoardClick(event) {
  if(state.busy) return;
  const match=currentMatch(),displayed=event.target.closest('.game-card');
  if(!match||!displayed||displayed.dataset.matchId!==match.id||state.watchedMatchId&&state.watchedMatchId!==match.id) return;
  const game=myGame();
  if(!game||!game.mySide||game.over||!game.rolled||game.turn!==game.mySide) return;
  const legal=game.legalMoves||[];
  const point=event.target.closest('[data-point]'),bar=event.target.closest('[data-bar]'),off=event.target.closest('[data-dest="off"]');
  if(off) {
    if(off.dataset.offSide!==game.mySide) return;
    if(state.selectedFrom!==null&&legal.some(move=>String(move.from)===String(state.selectedFrom)&&move.to==='off')) return roomPost(`/matches/${encodeURIComponent(match.id)}/move`,{from:state.selectedFrom,to:'off'});
    return;
  }
  if(bar) {
    if(bar.dataset.bar===game.mySide&&legal.some(move=>move.from==='bar')) {state.selectedFrom='bar';render();}
    return;
  }
  if(!point) return;
  const index=Number(point.dataset.point);
  const isTarget=state.selectedFrom!==null&&legal.some(move=>String(move.from)===String(state.selectedFrom)&&String(move.to)===String(index));
  if(isTarget) return roomPost(`/matches/${encodeURIComponent(match.id)}/move`,{from:state.selectedFrom,to:index});
  const isOwn=game.board.points[index][game.mySide]>0&&legal.some(move=>String(move.from)===String(index));
  if(isOwn) {state.selectedFrom=index;render();return;}
  if(state.selectedFrom!==null) {state.selectedFrom=null;render();}
}
function updateRoundInput(form) {
  const mode=form?.querySelector('[name="roundMode"]'),rounds=form?.querySelector('[name="rounds"]');
  if(mode&&rounds) rounds.disabled=mode.value==='unlimited';
}

document.addEventListener('click',async event=>{
  const insideModal=event.target.closest('.modal');
  const button=insideModal?event.target.closest('.modal [data-action]'):event.target.closest('[data-action]');
  if(button) {event.preventDefault();try{await action(button.dataset.action,button,event);}catch(error){showToast(error.message);}return;}
  if(event.target.classList.contains('modal-backdrop')) {closeModal();return;}
  if(insideModal) return;
  if(event.target.closest('#boardSurface')||event.target.closest('.off-tray')) {try{await handleBoardClick(event);}catch(error){showToast(error.message);}}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='host-form') {event.preventDefault();const submit=event.target.querySelector('[type=submit]');if(submit)submit.disabled=true;try{await createTournament(event.target);}catch(error){showToast(error.message);if(submit)submit.disabled=false;}}
  if(event.target.id==='join-form') {event.preventDefault();const submit=event.target.querySelector('[type=submit]');if(submit)submit.disabled=true;try{await joinTournament(event.target);}catch(error){showToast(error.message);if(submit)submit.disabled=false;}}
  if(event.target.id==='settings-form') {event.preventDefault();const form=event.target,settings=settingsFromForm(new FormData(form));await roomPost('/settings',{settings},'הגדרות הטורניר נשמרו.');}
});
document.addEventListener('change',event=>{
  if(event.target.matches('#host-form [name="roundMode"], #settings-form [name="roundMode"]')) updateRoundInput(event.target.form);
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&state.modal) closeModal();
  const currentTab=event.target.closest?.('.dashboard-tab');
  if(currentTab) {
    const tabs=[...document.querySelectorAll('.dashboard-tab')],index=tabs.indexOf(currentTab);
    const targetIndex=event.key==='ArrowLeft'?Math.min(tabs.length-1,index+1):event.key==='ArrowRight'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
    if(targetIndex>=0&&tabs[targetIndex]) {
      event.preventDefault(); state.dashboardTab=tabs[targetIndex].dataset.tab; render();
      document.getElementById(`tab-${state.dashboardTab}`)?.focus(); return;
    }
  }
  if(event.key==='Enter'&&event.target.id==='joinCode') document.getElementById('joinName')?.focus();
});
document.addEventListener('fullscreenchange',()=>{
  if(!document.fullscreenElement&&state.presentation) { state.presentation=false; render(); }
});

async function boot() {
  if(!state.clockTimer) state.clockTimer=setInterval(updateClockDisplay,250);
  const params=new URLSearchParams(location.search),viewCode=params.get('view')||'';
  if(viewCode) {
    const token=savedSeat(viewCode);
    try {
      const data=await request(`${codePath(viewCode)}?token=${encodeURIComponent(token)}`);
      state.token=token; state.code=data.tournament.code;
      setSnapshot(data,true); connectRoom(state.code,token); return;
    } catch(error) { render(); showToast(error.message); return; }
  }
  const queryCode=params.get('room')||'';
  if(queryCode) {
    const token=savedSeat(queryCode);
    if(token) {
      try {
        const data=await request(`${codePath(queryCode)}?token=${encodeURIComponent(token)}`);
        if(data.viewerId) {returnToRoom(data.tournament.code,token,data);return;}
      } catch {}
    }
    state.pendingJoinCode=queryCode;
    render(); openJoin(queryCode); return;
  }
  render();
}
boot();
