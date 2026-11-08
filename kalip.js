/* =====================================================================
   KALIP TAKİBİ
   index.html içindeki sb (Supabase), $ ve window.oturum kullanılır.
   Yetkiler Supabase'te de uygulanır; buradaki gizleme yalnızca arayüz içindir.
   Dış bağımlılık: Excel için ExcelJS 4.4.0 (ilk "Excel'e aktar"da yüklenir).
   ===================================================================== */
(function () {
  "use strict";

  const DEPO = "kalip-fotolari";
  const EXCELJS_URL = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const FOTO_UZUN_KENAR = 1200;
  const FOTO_HEDEF_BAYT = 400 * 1024;

  let kaliplar = [];        // aktif kalıplar (kalip_durumlari)
  let tedarikciler = [];    // aktif tedarikçiler
  let acik = false;
  let yenilemeZamanlayici = null;

  const yon = () => !!(window.oturum && window.oturum.yonetim);

  /* ---------------- Yardımcılar ---------------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tarihBicim = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const tarihSaat = (iso) => iso ? tarihBicim.format(new Date(iso)) : "";
  const adetYaz = (n) => n == null ? "Belirtilmedi" : Number(n).toLocaleString("tr-TR") + " adet";
  const sonUretimYaz = (k) => k.tamamlanan_var ? "Son üretim • " + adetYaz(k.son_uretim_adedi) : "Henüz tamamlanmış gönderim yok";
  const parcaYaz = (n) => n + " parça";
  const iki = (n) => String(n).padStart(2, "0");
  function yerelGirdi(iso) {   // datetime-local değeri
    const d = new Date(iso);
    return `${d.getFullYear()}-${iki(d.getMonth() + 1)}-${iki(d.getDate())}T${iki(d.getHours())}:${iki(d.getMinutes())}`;
  }
  const yereldenIso = (v) => v ? new Date(v).toISOString() : null;
  const bekle = (ms) => new Promise(r => setTimeout(r, ms));

  function hataMetni(err) {
    const m = (err && err.message) || String(err || "");
    const k = m.toLowerCase();
    if (k.includes("failed to fetch") || k.includes("networkerror") || k.includes("network request"))
      return "Sunucuya ulaşılamadı. İnternet bağlantısını kontrol edip tekrar deneyin.";
    if (k.includes("jwt") && k.includes("expired")) return "Oturum süresi doldu. Sayfayı yenileyin.";
    return m || "Bilinmeyen bir hata oluştu.";
  }
  async function rpc(ad, parametreler) {
    const { data, error } = await sb.rpc(ad, parametreler);
    if (error) throw new Error(hataMetni(error));
    return data;
  }
  async function sorgu(p) {
    const { data, error } = await p;
    if (error) throw new Error(hataMetni(error));
    return data;
  }

  let bildirimZaman = null;
  function bildir(mesaj, hatali) {
    const b = $("#bildirim");
    b.textContent = mesaj;
    b.classList.toggle("hatali", !!hatali);
    b.hidden = false;
    clearTimeout(bildirimZaman);
    bildirimZaman = setTimeout(() => { b.hidden = true; }, hatali ? 6000 : 3200);
  }

  /* ---------------- Pencere sistemi ---------------- */
  function pencereAc({ baslik, govde, alt, kucuk, kapanabilir = true }) {
    const perde = document.createElement("div");
    perde.className = "perde";
    perde.innerHTML = `
      <div class="pencere${kucuk ? " kucuk" : ""}" role="dialog" aria-modal="true">
        <div class="pencere-ust"><h3>${esc(baslik)}</h3><button type="button" class="kapat-x" aria-label="Kapat">×</button></div>
        <div class="pencere-govde">${govde || ""}</div>
        ${alt ? `<div class="pencere-alt">${alt}</div>` : ""}
      </div>`;
    document.body.appendChild(perde);
    const p = {
      el: perde,
      mesgul: false,
      kapat() { if (perde.isConnected) perde.remove(); document.removeEventListener("keydown", tus); p.onKapat && p.onKapat(); },
      q: (s) => perde.querySelector(s),
      govde: perde.querySelector(".pencere-govde"),
      baslik(t) { perde.querySelector(".pencere-ust h3").textContent = t; },
    };
    perde._p = p;
    const tus = (e) => { if (e.key === "Escape" && !p.mesgul && kapanabilir && perde === sonPerde()) p.kapat(); };
    document.addEventListener("keydown", tus);
    perde.querySelector(".kapat-x").onclick = () => { if (!p.mesgul) p.kapat(); };
    return p;
  }
  const sonPerde = () => { const t = document.querySelectorAll(".perde"); return t[t.length - 1]; };
  const tumPencereleriKapat = () => document.querySelectorAll(".perde").forEach(x => x._p ? x._p.kapat() : x.remove());

  // İşlem sürerken pencerenin bütün düğmelerini pasifleştirir
  async function mesgulCalistir(p, fn) {
    if (p.mesgul) return;
    p.mesgul = true;
    const dugmeler = [...p.el.querySelectorAll("button, input, select, textarea")];
    const onceki = dugmeler.map(d => d.disabled);
    dugmeler.forEach(d => d.disabled = true);
    try { return await fn(); }
    finally {
      p.mesgul = false;
      dugmeler.forEach((d, i) => { if (d.isConnected) d.disabled = onceki[i]; });
    }
  }

  function onayIste({ baslik, metin, buton, tehlike }) {
    return new Promise(coz => {
      const p = pencereAc({
        baslik, kucuk: true,
        govde: `<p class="onay-metin">${metin}</p>`,
        alt: `<button type="button" class="btn sade" data-i="iptal">İptal</button>
              <button type="button" class="btn ana${tehlike ? " tehlike" : ""}" data-i="tamam">${esc(buton)}</button>`,
      });
      let sonuc = false;
      p.onKapat = () => coz(sonuc);
      p.q('[data-i="iptal"]').onclick = () => p.kapat();
      p.q('[data-i="tamam"]').onclick = () => { sonuc = true; p.kapat(); };
      p.q('[data-i="tamam"]').focus();
    });
  }

  /* ---------------- İşçi karakteri ---------------- */
  const ISCI_SVG = `
    <svg class="isci-svg" width="16" height="28" viewBox="0 0 16 28" aria-hidden="true">
      <rect class="bacak bacak-sol" x="5" y="19.5" width="2.7" height="7.6" rx="1" fill="#2b3240"/>
      <rect class="bacak bacak-sag" x="8.3" y="19.5" width="2.7" height="7.6" rx="1" fill="#2b3240"/>
      <rect x="4.3" y="25.6" width="3.6" height="2.2" rx="1" fill="#15171c"/>
      <rect x="8.1" y="25.6" width="3.6" height="2.2" rx="1" fill="#15171c"/>
      <rect x="2.4" y="9.6" width="2.2" height="7.4" rx="1.1" fill="#d6d9df"/>
      <rect x="11.4" y="9.6" width="2.2" height="7.4" rx="1.1" fill="#d6d9df"/>
      <circle cx="3.5" cy="17.3" r="1.2" fill="#f0c9a4"/>
      <circle cx="12.5" cy="17.3" r="1.2" fill="#f0c9a4"/>
      <rect x="4.2" y="8.6" width="7.6" height="11.4" rx="2.2" fill="#d6d9df"/>
      <path d="M5.2 11.2h5.6v9.3H5.2z" fill="#1f3a8a"/>
      <path d="M5.6 8.9l.9 2.3M10.4 8.9l-.9 2.3" stroke="#1f3a8a" stroke-width="1"/>
      <circle cx="8" cy="4.6" r="3.6" fill="#f0c9a4"/>
      <path d="M4.4 4.2a3.6 3.6 0 0 1 7.2 0c-1.2-.9-2.4-1.3-3.6-1.3s-2.4.4-3.6 1.3z" fill="#3b2a1d"/>
      <circle cx="6.7" cy="5" r=".45" fill="#222"/><circle cx="9.3" cy="5" r=".45" fill="#222"/>
    </svg>`;

  function animasyonOynat(tur, kalipId, kaynak) {
    try {
      if (!kaynak || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const alan = $("#kalipSayfa .kalip-alan");
      const katman = alan && alan.querySelector(".isci-katman");
      const bekleyen = alan && alan.querySelector(".isci-bekle");
      const hedefListe = alan && alan.querySelector(tur === "gonder" ? "#disListe" : "#rafListe");
      const hedefKart = hedefListe && hedefListe.querySelector(`[data-id="${kalipId}"]`);
      if (!katman || !bekleyen || !hedefKart) return;

      // Hedef kartı kendi listesinde görünür alana getir
      const lr = hedefListe.getBoundingClientRect();
      let cr = hedefKart.getBoundingClientRect();
      if (cr.top < lr.top || cr.bottom > lr.bottom)
        hedefListe.scrollTop += cr.top - lr.top - Math.max(0, (lr.height - cr.height) / 2);
      cr = hedefKart.getBoundingClientRect();
      const vr = hedefListe.getBoundingClientRect();
      const ar = alan.getBoundingClientRect();
      const sinirla = (v, a, b) => Math.max(a, Math.min(b, v));
      const hedef = {   // alan'a göre, liste görünür alanıyla sınırlı
        left: cr.left - ar.left, right: cr.right - ar.left,
        top: sinirla(cr.top, vr.top, vr.bottom) - ar.top, bottom: sinirla(cr.bottom, vr.top, vr.bottom) - ar.top,
      };
      const br = bekleyen.getBoundingClientRect();
      const P0 = { x: br.left + br.width / 2 - ar.left, y: br.bottom - ar.top };

      const raf = alan.querySelector("#rafKutu").getBoundingClientRect();
      const dis = alan.querySelector("#disKutu").getBoundingClientRect();
      const yanYana = raf.right <= dis.left + 1;
      const W = 16, H = 28;
      const ortaY = (r) => (r.top + r.bottom) / 2 + H / 2;
      let P1, P2;
      if (yanYana) {
        // Göndermede raf kartının sağ kenarından dışarıdaki kartın sol kenarına (geri almada tersi)
        P1 = tur === "gonder" ? { x: kaynak.right - W / 2 - 2, y: ortaY(kaynak) } : { x: kaynak.left + W / 2 + 2, y: ortaY(kaynak) };
        P2 = tur === "gonder" ? { x: hedef.left + W / 2 + 2, y: ortaY(hedef) } : { x: hedef.right - W / 2 - 2, y: ortaY(hedef) };
      } else {
        // Alt alta (telefon): raf üstte, dışarıdaki altta
        const ortaX = (r) => (r.left + r.right) / 2;
        P1 = tur === "gonder" ? { x: ortaX(kaynak), y: kaynak.bottom + 2 } : { x: ortaX(kaynak), y: kaynak.top + H - 2 };
        P2 = tur === "gonder" ? { x: ortaX(hedef), y: hedef.top + H - 2 } : { x: ortaX(hedef), y: hedef.bottom + 2 };
      }
      const ah = alan.clientHeight, aw = alan.clientWidth;
      [P0, P1, P2].forEach(p => { p.x = sinirla(p.x, W / 2, aw - W / 2); p.y = sinirla(p.y, H, ah); });

      const gezen = document.createElement("div");
      gezen.className = "isci-gezen yuruyor";
      gezen.innerHTML = ISCI_SVG + `<div class="kalip-simge"></div>`;
      katman.appendChild(gezen);
      bekleyen.style.visibility = "hidden";

      const t = (p) => `translate(${p.x - W / 2}px, ${p.y - H}px)`;
      const yon1 = Math.sign(P1.x - P0.x) || 1, yon2 = Math.sign(P2.x - P1.x) || 1, yon3 = Math.sign(P0.x - P2.x) || 1;
      const sure = 1350;
      const a1 = gezen.animate([
        { transform: t(P0), offset: 0 }, { transform: t(P1), offset: 0.24 }, { transform: t(P1), offset: 0.31 },
        { transform: t(P2), offset: 0.72 }, { transform: t(P2), offset: 0.79 }, { transform: t(P0), offset: 1 },
      ], { duration: sure, easing: "linear" });
      const s = (d) => `scaleX(${yanYana ? d : 1})`;
      gezen.querySelector(".isci-svg").animate([
        { transform: s(yon1), offset: 0 }, { transform: s(yon1), offset: 0.3 }, { transform: s(yon2), offset: 0.301 },
        { transform: s(yon2), offset: 0.78 }, { transform: s(yon3), offset: 0.781 }, { transform: s(yon3), offset: 1 },
      ], { duration: sure });
      gezen.querySelector(".kalip-simge").animate([
        { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.26 }, { opacity: 1, offset: 0.3 },
        { opacity: 1, offset: 0.74 }, { opacity: 0, offset: 0.78 }, { opacity: 0, offset: 1 },
      ], { duration: sure });
      const bitir = () => { gezen.remove(); bekleyen.style.visibility = ""; };
      a1.finished.then(bitir, bitir);
    } catch (e) {
      console.warn("Animasyon oynatılamadı:", e);
      const b = document.querySelector(".isci-bekle"); if (b) b.style.visibility = "";
    }
  }

  // Kartın, kendi listesinin görünür alanıyla sınırlı konumu (alan'a göre)
  function kartKonumu(kalipId) {
    const alan = $("#kalipSayfa .kalip-alan");
    const kart = alan && alan.querySelector(`.kart-kalip[data-id="${kalipId}"]`);
    if (!kart) return null;
    const ar = alan.getBoundingClientRect(), cr = kart.getBoundingClientRect();
    const lr = kart.closest(".liste").getBoundingClientRect();
    const s = (v) => Math.max(lr.top, Math.min(lr.bottom, v));
    return { left: cr.left - ar.left, right: cr.right - ar.left, top: s(cr.top) - ar.top, bottom: s(cr.bottom) - ar.top };
  }

  /* ---------------- Sayfa iskeleti ---------------- */
  function iskeletKur() {
    const s = $("#kalipSayfa");
    s.innerHTML = `
      <div class="arac-cubugu">
        <button type="button" class="btn sade" id="kGeri">← Geri</button>
        <h2>Kalıp Takibi</h2>
        <span class="bosluk"></span>
        ${yon() ? `
          <button type="button" class="btn ana" id="kYeni">+ Yeni kalıp</button>
          <button type="button" class="btn" id="kTedarikci">Tedarikçiler</button>
          <button type="button" class="btn" id="kArsiv">Arşiv</button>` : ""}
      </div>
      <div class="kalip-alan">
        <section class="liste-kutu" id="rafKutu">
          <div class="liste-baslik"><span class="ad">Raftaki Kalıplar</span><span class="sayi" id="rafSayi">–</span></div>
          <div class="liste" id="rafListe"><div class="liste-bos">Yükleniyor…</div></div>
        </section>
        <div class="orta"><div class="isci-bekle" title="Depo görevlisi">${ISCI_SVG}</div></div>
        <section class="liste-kutu" id="disKutu">
          <div class="liste-baslik"><span class="ad">Dışarıdaki Kalıplar</span><span class="sayi" id="disSayi">–</span></div>
          <div class="liste" id="disListe"><div class="liste-bos">Yükleniyor…</div></div>
        </section>
        <div class="isci-katman"></div>
      </div>
      <div class="alt-cubuk"><button type="button" class="btn ana" id="kExcel">Excel'e aktar</button></div>`;
    $("#kGeri").onclick = () => { location.hash = ""; };
    $("#kExcel").onclick = (e) => excelAktar(e.currentTarget);
    if (yon()) {
      $("#kYeni").onclick = () => kalipFormu(null);
      $("#kTedarikci").onclick = tedarikciPenceresi;
      $("#kArsiv").onclick = arsivPenceresi;
    }
    s.onclick = (e) => {
      const kart = e.target.closest(".kart-kalip");
      if (kart && s.contains(kart)) detayAc(kart.dataset.id);
    };
  }

  function kartHtml(k, disarida) {
    return `<button type="button" class="kart-kalip" data-id="${esc(k.id)}">
      <div class="k-ad">${esc(k.urun_adi)}</div>
      <div class="k-alt"><span>${esc(parcaYaz(k.parca_sayisi))}</span>
        ${disarida ? `<span class="k-ted">${esc(k.mevcut_tedarikci_ad)}</span><span>${esc(tarihSaat(k.mevcut_gonderme_zamani))}</span>` : ""}
      </div></button>`;
  }

  function listeleriCiz() {
    if (!$("#rafListe")) return;
    const raf = kaliplar.filter(k => !k.acik_gonderim_id);
    const dis = kaliplar.filter(k => k.acik_gonderim_id);
    $("#rafSayi").textContent = raf.length;
    $("#disSayi").textContent = dis.length;
    $("#rafListe").innerHTML = raf.length ? raf.map(k => kartHtml(k, false)).join("")
      : `<div class="liste-bos">${yon() ? "Rafta kalıp yok. Yeni kalıbı “+ Yeni kalıp” ile ekleyin." : "Rafta kalıp yok."}</div>`;
    $("#disListe").innerHTML = dis.length ? dis.map(k => kartHtml(k, true)).join("")
      : `<div class="liste-bos">Dışarıda kalıp yok.</div>`;
  }

  async function verileriYukle(sessiz) {
    try {
      const [k, t] = await Promise.all([
        sorgu(sb.from("kalip_durumlari").select("*").eq("arsivde", false).order("urun_adi")),
        sorgu(sb.from("tedarikciler").select("id, ad").eq("aktif", true).order("ad")),
      ]);
      kaliplar = k; tedarikciler = t;
      listeleriCiz();
    } catch (e) {
      if (!sessiz) bildir("Kalıplar yüklenemedi: " + e.message, true);
      if (!kaliplar.length && $("#rafListe")) {
        $("#rafListe").innerHTML = $("#disListe").innerHTML = `<div class="liste-bos">Yüklenemedi. İnternet bağlantısını kontrol edin.</div>`;
      }
    }
  }

  /* ---------------- Kalıp detayı ---------------- */
  async function detayAc(id) {
    const p = pencereAc({ baslik: "Kalıp", govde: `<div class="liste-bos">Yükleniyor…</div>` });
    p.detayId = id;
    p.yenile = () => detayDoldur(p);
    await detayDoldur(p);
  }

  async function detayDoldur(p) {
    let k, gecmis;
    try {
      [k, gecmis] = await Promise.all([
        sorgu(sb.from("kalip_durumlari").select("*").eq("id", p.detayId).maybeSingle()),
        sorgu(sb.from("gonderimler").select("*, tedarikciler(ad, aktif)").eq("kalip_id", p.detayId).order("gonderme_zamani", { ascending: false })),
      ]);
    } catch (e) {
      p.govde.innerHTML = `<p class="form-hata">Kalıp bilgileri yüklenemedi: ${esc(e.message)}</p>`;
      return;
    }
    if (!k) {
      p.govde.innerHTML = `<p class="form-hata">Bu kalıp artık bulunmuyor. Başka bir kullanıcı silmiş ya da arşive almış olabilir.</p>`;
      verileriYukle(true);
      return;
    }
    p.kalip = k;
    p.baslik(k.urun_adi);
    const disarida = !!k.acik_gonderim_id;
    const konum = (k.arsivde ? `<span class="durum-rozet arsiv">Arşivde</span> ` : "") +
      (disarida ? `<span class="durum-rozet dis">Dışarıda</span> ${esc(k.mevcut_tedarikci_ad)} · ${esc(tarihSaat(k.mevcut_gonderme_zamani))}`
                : `<span class="durum-rozet raf">Rafta</span>`);
    const eylem = [];
    if (!k.arsivde) {
      if (!disarida) eylem.push(`<button type="button" class="btn ana" data-e="gonder">Tedarikçiye gönder</button>`);
      else eylem.push(`<button type="button" class="btn ana" data-e="geri">Rafa geri al</button>`);
      if (yon()) {
        eylem.push(`<button type="button" class="btn" data-e="duzenle">Bilgileri düzenle</button>`);
        eylem.push(`<button type="button" class="btn tehlike" data-e="arsivle">Sil / Arşive al</button>`);
      }
    } else if (yon()) {
      eylem.push(`<button type="button" class="btn ana" data-e="getir">Arşivden geri getir</button>`);
      eylem.push(`<button type="button" class="btn" data-e="duzenle">Bilgileri düzenle</button>`);
      eylem.push(`<button type="button" class="btn tehlike" data-e="sil">Kalıcı sil</button>`);
    }

    p.govde.innerHTML = `
      <div class="detay">
        <div>
          <div class="foto-kutu" id="fotoKutu">${k.foto_yolu ? "Fotoğraf yükleniyor…" : "Fotoğraf eklenmemiş"}</div>
          ${yon() ? `<div class="foto-islem">
              <button type="button" class="btn kucuk" data-e="foto">${k.foto_yolu ? "Fotoğrafı değiştir" : "Fotoğraf ekle"}</button>
              <input type="file" accept="image/*" hidden id="fotoGirdi">
            </div>` : ""}
        </div>
        <div>
          <dl class="bilgi">
            <dt>Ürün adı</dt><dd>${esc(k.urun_adi)}</dd>
            <dt>Açıklama</dt><dd>${k.aciklama ? esc(k.aciklama) : "—"}</dd>
            <dt>Parça sayısı</dt><dd>${esc(parcaYaz(k.parca_sayisi))}</dd>
            <dt>Mevcut konum</dt><dd>${konum}</dd>
            <dt>Son tedarikçi</dt><dd>${k.son_tedarikci_ad ? esc(k.son_tedarikci_ad) : "—"}</dd>
            <dt>Son üretim</dt><dd>${esc(k.tamamlanan_var ? adetYaz(k.son_uretim_adedi) : "Henüz tamamlanmış gönderim yok")}</dd>
          </dl>
          <div class="eylemler">${eylem.join("")}</div>
        </div>
      </div>
      <h4 class="gecmis-baslik">Hareket geçmişi <span class="sayi">${gecmis.length}</span></h4>
      ${gecmis.length ? gecmis.map(g => hareketHtml(g)).join("") : `<p class="not">Henüz gönderim yok.</p>`}`;

    // Fotoğraf: detay açılınca yüklenir
    if (k.foto_yolu) {
      const kutu = p.q("#fotoKutu");
      sb.storage.from(DEPO).createSignedUrl(k.foto_yolu, 600).then(({ data, error }) => {
        if (!kutu.isConnected) return;
        if (error || !data) { kutu.textContent = "Fotoğraf yüklenemedi."; return; }
        const img = new Image();
        img.alt = k.urun_adi;
        img.onload = () => { kutu.innerHTML = ""; kutu.appendChild(img); };
        img.onerror = () => { kutu.textContent = "Fotoğraf yüklenemedi."; };
        img.onclick = () => window.open(data.signedUrl, "_blank", "noopener");
        img.src = data.signedUrl;
      });
    }

    const e = (ad, fn) => { const b = p.q(`[data-e="${ad}"]`); if (b) b.onclick = fn; };
    e("gonder", () => gonderFormu(k));
    e("geri", () => geriAlFormu(k));
    e("duzenle", () => kalipFormu(k, p));
    e("arsivle", () => arsivle(k, p));
    e("getir", () => arsivdenGetir(k, p));
    e("sil", () => kaliciSil(k, p));
    e("foto", () => p.q("#fotoGirdi").click());
    const fg = p.q("#fotoGirdi");
    if (fg) fg.onchange = () => { const f = fg.files[0]; fg.value = ""; if (f) fotoDegistir(k, f, p); };
    p.govde.querySelectorAll("[data-duzelt]").forEach(b => {
      b.onclick = () => duzeltFormu(gecmis.find(g => g.id === b.dataset.duzelt), p);
    });
  }

  function hareketHtml(g) {
    const ted = g.tedarikciler || {};
    const acikMi = !g.donus_zamani;
    return `<div class="hareket">
      <div class="h-ust">
        <strong>${esc(ted.ad || "—")}${ted.aktif === false ? ` <span class="kaldirildi">(listeden kaldırıldı)</span>` : ""}</strong>
        <span class="durum-rozet ${acikMi ? "dis" : "raf"}">${acikMi ? "Dışarıda" : "Döndü"}</span>
        ${g.duzeltme_zamani ? `<span class="duzeltildi" title="Son düzeltme: ${esc(tarihSaat(g.duzeltme_zamani))}">düzeltildi</span>` : ""}
        ${yon() ? `<button type="button" class="btn kucuk sade" data-duzelt="${esc(g.id)}">Düzelt</button>` : ""}
      </div>
      <div class="h-satir"><span class="h-et">Gönderildi</span><span>${esc(tarihSaat(g.gonderme_zamani))} · ${esc(g.gonderen_ad)}</span></div>
      ${g.gonderme_aciklama ? `<div class="h-satir"><span class="h-et">Açıklama</span><span class="h-acik">${esc(g.gonderme_aciklama)}</span></div>` : ""}
      ${acikMi ? "" : `
        <div class="h-satir"><span class="h-et">Döndü</span><span>${esc(tarihSaat(g.donus_zamani))} · ${esc(g.geri_alan_ad)}</span></div>
        ${g.donus_aciklama ? `<div class="h-satir"><span class="h-et">Açıklama</span><span class="h-acik">${esc(g.donus_aciklama)}</span></div>` : ""}
        <div class="h-satir"><span class="h-et">Üretim</span><span>${esc(adetYaz(g.uretim_adedi))}</span></div>`}
    </div>`;
  }

  /* ---------------- Gönderme / geri alma ---------------- */
  function gonderFormu(k) {
    const secenek = tedarikciler.map(t => `<option value="${esc(t.id)}">${esc(t.ad)}</option>`).join("");
    const p = pencereAc({
      baslik: "Tedarikçiye gönder", kucuk: true,
      govde: `<form id="f">
        <p class="not"><strong>${esc(k.urun_adi)}</strong> · ${esc(parcaYaz(k.parca_sayisi))}</p>
        <label>Tedarikçi
          <select name="ted" required ${tedarikciler.length ? "" : "disabled"}>
            <option value="">${tedarikciler.length ? "Seçin…" : "Listede tedarikçi yok"}</option>${secenek}
          </select>
        </label>
        <p class="not">${yon() ? "Tedarikçi listesini “Tedarikçiler” düğmesinden düzenleyebilirsiniz." : "Tedarikçi eklenmesi için yönetime başvurun."}</p>
        <label>Gönderme açıklaması (isteğe bağlı)<textarea name="aciklama" maxlength="1000"></textarea></label>
        <p class="form-hata" hidden></p>
      </form>`,
      alt: `<button type="button" class="btn sade" data-i="iptal">İptal</button>
            <button type="submit" form="f" class="btn ana" ${tedarikciler.length ? "" : "disabled"}>Gönder</button>`,
    });
    p.q('[data-i="iptal"]').onclick = () => p.kapat();
    const f = p.q("#f"), hata = p.q(".form-hata");
    f.onsubmit = (ev) => {
      ev.preventDefault();
      hata.hidden = true;
      if (!f.ted.value) { hata.textContent = "Tedarikçi seçin."; hata.hidden = false; return; }
      mesgulCalistir(p, async () => {
        try {
          await rpc("kalip_gonder", { p_kalip_id: k.id, p_tedarikci_id: f.ted.value, p_aciklama: f.aciklama.value });
        } catch (e) {
          hata.textContent = e.message; hata.hidden = false;
          verileriYukle(true);
          return;
        }
        // Kayıt başarılı: önce kaynak kartın yeri, sonra liste güncellenir, sonra animasyon
        const kaynak = kartKonumu(k.id);
        tumPencereleriKapat();
        await verileriYukle(true);
        bildir("Kalıp tedarikçiye teslim edildi");
        animasyonOynat("gonder", k.id, kaynak);
      });
    };
  }

  function geriAlFormu(k) {
    const p = pencereAc({
      baslik: "Rafa geri al", kucuk: true,
      govde: `<form id="f">
        <p class="not"><strong>${esc(k.urun_adi)}</strong> · ${esc(k.mevcut_tedarikci_ad)} · gönderim ${esc(tarihSaat(k.mevcut_gonderme_zamani))}</p>
        <label>Kaç adet üretildi? (isteğe bağlı)
          <input type="text" name="adet" inputmode="numeric" autocomplete="off" placeholder="Boş bırakılırsa: Belirtilmedi">
        </label>
        <label>Açıklama (isteğe bağlı)<textarea name="aciklama" maxlength="1000"></textarea></label>
        <p class="form-hata" hidden></p>
      </form>`,
      alt: `<button type="button" class="btn sade" data-i="iptal">İptal</button>
            <button type="submit" form="f" class="btn ana">Rafa geri al</button>`,
    });
    p.q('[data-i="iptal"]').onclick = () => p.kapat();
    const f = p.q("#f"), hata = p.q(".form-hata");
    f.onsubmit = (ev) => {
      ev.preventDefault();
      hata.hidden = true;
      const adet = adetOku(f.adet.value);
      if (adet === undefined) { hata.textContent = "Üretim adedi sıfır veya daha büyük bir tam sayı olmalıdır (ör. 5000)."; hata.hidden = false; return; }
      mesgulCalistir(p, async () => {
        try {
          await rpc("kalip_geri_al", { p_kalip_id: k.id, p_uretim_adedi: adet, p_aciklama: f.aciklama.value });
        } catch (e) {
          hata.textContent = e.message; hata.hidden = false;
          verileriYukle(true);
          return;
        }
        const kaynak = kartKonumu(k.id);
        tumPencereleriKapat();
        await verileriYukle(true);
        bildir("Kalıp rafa alındı");
        animasyonOynat("geri", k.id, kaynak);
      });
    };
  }

  // "" -> null (Belirtilmedi), "0" -> 0, "5.000" / "5000" -> 5000, geçersiz -> undefined
  function adetOku(v) {
    const s = String(v || "").replace(/[\s.]/g, "");
    if (s === "") return null;
    if (!/^\d{1,9}$/.test(s)) return undefined;
    return parseInt(s, 10);
  }

  /* ---------------- Geçmiş düzeltme (Yönetim) ---------------- */
  function duzeltFormu(g, detay) {
    if (!g) return;
    const acikMi = !g.donus_zamani;
    const liste = tedarikciler.slice();
    if (!liste.some(t => t.id === g.tedarikci_id))
      liste.unshift({ id: g.tedarikci_id, ad: (g.tedarikciler && g.tedarikciler.ad || "?") + " (listeden kaldırıldı)" });
    const p = pencereAc({
      baslik: "Gönderimi düzelt", kucuk: true,
      govde: `<form id="f">
        <p class="not">Gönderen: ${esc(g.gonderen_ad)}${acikMi ? "" : ` · Geri alan: ${esc(g.geri_alan_ad)}`} (değişmez)</p>
        <label>Tedarikçi<select name="ted" required>
          ${liste.map(t => `<option value="${esc(t.id)}" ${t.id === g.tedarikci_id ? "selected" : ""}>${esc(t.ad)}</option>`).join("")}
        </select></label>
        <label>Gönderme tarihi ve saati<input type="datetime-local" name="gtarih" required value="${yerelGirdi(g.gonderme_zamani)}"></label>
        <label>Gönderme açıklaması<textarea name="gacik" maxlength="1000">${esc(g.gonderme_aciklama || "")}</textarea></label>
        ${acikMi ? `<p class="not">Kalıp hâlâ dışarıda. Dönüş bilgileri “Rafa geri al” ile girilir.</p>` : `
          <label>Dönüş tarihi ve saati<input type="datetime-local" name="dtarih" required value="${yerelGirdi(g.donus_zamani)}"></label>
          <label>Dönüş açıklaması<textarea name="dacik" maxlength="1000">${esc(g.donus_aciklama || "")}</textarea></label>
          <label>Üretim adedi (boş = Belirtilmedi)
            <input type="text" name="adet" inputmode="numeric" autocomplete="off" value="${g.uretim_adedi == null ? "" : g.uretim_adedi}">
          </label>`}
        <p class="form-hata" hidden></p>
      </form>`,
      alt: `<button type="button" class="btn sade" data-i="iptal">İptal</button>
            <button type="submit" form="f" class="btn ana">Kaydet</button>`,
    });
    p.q('[data-i="iptal"]').onclick = () => p.kapat();
    const f = p.q("#f"), hata = p.q(".form-hata");
    f.onsubmit = (ev) => {
      ev.preventDefault();
      hata.hidden = true;
      const goster = (m) => { hata.textContent = m; hata.hidden = false; };
      if (!f.gtarih.value) return goster("Gönderme tarihi zorunludur.");
      let adet = null;
      if (!acikMi) {
        if (!f.dtarih.value) return goster("Dönüş tarihi zorunludur.");
        if (new Date(f.dtarih.value) < new Date(f.gtarih.value)) return goster("Dönüş tarihi gönderme tarihinden önce olamaz.");
        adet = adetOku(f.adet.value);
        if (adet === undefined) return goster("Üretim adedi sıfır veya daha büyük bir tam sayı olmalıdır.");
      }
      mesgulCalistir(p, async () => {
        try {
          await rpc("gonderim_duzelt", {
            p_id: g.id, p_tedarikci_id: f.ted.value,
            p_gonderme_zamani: yereldenIso(f.gtarih.value), p_gonderme_aciklama: f.gacik.value,
            p_donus_zamani: acikMi ? null : yereldenIso(f.dtarih.value),
            p_donus_aciklama: acikMi ? null : f.dacik.value, p_uretim_adedi: acikMi ? null : adet,
          });
        } catch (e) { return goster(e.message); }
        p.kapat();
        bildir("Düzeltme kaydedildi");
        detay.yenile();
        verileriYukle(true);
      });
    };
  }

  /* ---------------- Kalıp oluşturma / düzenleme (Yönetim) ---------------- */
  function kalipFormu(k, detay) {
    const yeni = !k;
    const p = pencereAc({
      baslik: yeni ? "Yeni kalıp" : "Kalıp bilgilerini düzenle", kucuk: true,
      govde: `<form id="f">
        <label>Ürün adı<input type="text" name="ad" required maxlength="150" value="${esc(k ? k.urun_adi : "")}"></label>
        <label>Açıklama (isteğe bağlı)<textarea name="aciklama" maxlength="2000">${esc(k && k.aciklama || "")}</textarea></label>
        <label>Parça sayısı (kalıbın kaç fiziksel parçadan oluştuğu)
          <input type="number" name="parca" required min="1" step="1" inputmode="numeric" value="${k ? k.parca_sayisi : ""}">
        </label>
        ${yeni ? `<label>Fotoğraf (isteğe bağlı, sonradan da eklenebilir)<input type="file" name="foto" accept="image/*"></label>
                  <p class="not">Yeni kalıp rafta başlar.</p>` : ""}
        <p class="form-hata" hidden></p>
      </form>`,
      alt: `<button type="button" class="btn sade" data-i="iptal">İptal</button>
            <button type="submit" form="f" class="btn ana">${yeni ? "Oluştur" : "Kaydet"}</button>`,
    });
    p.q('[data-i="iptal"]').onclick = () => p.kapat();
    const f = p.q("#f"), hata = p.q(".form-hata");
    f.ad.focus();
    f.onsubmit = (ev) => {
      ev.preventDefault();
      hata.hidden = true;
      const goster = (m) => { hata.textContent = m; hata.hidden = false; };
      const ad = f.ad.value.trim();
      const parca = Number(f.parca.value);
      if (!ad) return goster("Ürün adı zorunludur.");
      if (!Number.isInteger(parca) || parca < 1) return goster("Parça sayısı pozitif tam sayı olmalıdır.");
      mesgulCalistir(p, async () => {
        let id;
        try {
          if (yeni) id = await rpc("kalip_olustur", { p_urun_adi: ad, p_aciklama: f.aciklama.value, p_parca_sayisi: parca });
          else await rpc("kalip_guncelle", { p_id: k.id, p_urun_adi: ad, p_aciklama: f.aciklama.value, p_parca_sayisi: parca });
        } catch (e) { return goster(e.message); }
        let fotoHatasi = null;
        const dosya = yeni && f.foto.files[0];
        if (dosya) {
          p.q('button[type="submit"]').textContent = "Fotoğraf yükleniyor…";
          try { await fotoYukle(id, dosya); } catch (e) { fotoHatasi = e.message; }
        }
        p.kapat();
        if (fotoHatasi) bildir("Kalıp oluşturuldu ama fotoğraf yüklenemedi: " + fotoHatasi, true);
        else bildir(yeni ? "Kalıp oluşturuldu ve rafa eklendi" : "Kalıp bilgileri kaydedildi");
        if (detay) detay.yenile();
        verileriYukle(true);
      });
    };
  }

  /* ---------------- Fotoğraf ---------------- */
  async function fotoKucult(dosya) {
    let kaynak, w, h;
    try {
      kaynak = await createImageBitmap(dosya, { imageOrientation: "from-image" });
      w = kaynak.width; h = kaynak.height;
    } catch {
      kaynak = await new Promise((coz, red) => {
        const img = new Image();
        img.onload = () => coz(img);
        img.onerror = () => red(new Error("Bu dosya bir fotoğraf olarak okunamadı. JPEG veya PNG fotoğraf seçin."));
        img.src = URL.createObjectURL(dosya);
      });
      w = kaynak.naturalWidth; h = kaynak.naturalHeight;
    }
    const oran = Math.min(1, FOTO_UZUN_KENAR / Math.max(w, h));   // küçük fotoğraf büyütülmez
    const cw = Math.round(w * oran), ch = Math.round(h * oran);
    const tuval = document.createElement("canvas");
    tuval.width = cw; tuval.height = ch;
    const c = tuval.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, cw, ch);
    c.imageSmoothingQuality = "high";
    c.drawImage(kaynak, 0, 0, cw, ch);
    if (kaynak.close) kaynak.close();
    let blob = null;
    for (const kalite of [0.85, 0.78, 0.7, 0.62, 0.55]) {
      blob = await new Promise(coz => tuval.toBlob(coz, "image/jpeg", kalite));
      if (!blob) throw new Error("Fotoğraf sıkıştırılamadı.");
      if (blob.size <= FOTO_HEDEF_BAYT) break;
    }
    return blob;
  }

  // Yeni fotoğraf önce yüklenir, kayıt güncellenir, sonra eski dosya silinir.
  // Bir adım başarısız olursa mevcut fotoğraf yerinde kalır.
  async function fotoYukle(kalipId, dosya) {
    const blob = await fotoKucult(dosya);
    const yol = `${kalipId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error: yErr } = await sb.storage.from(DEPO).upload(yol, blob, { contentType: "image/jpeg", upsert: false });
    if (yErr) throw new Error("Fotoğraf depoya yüklenemedi (" + hataMetni(yErr) + ").");
    let eski;
    try { eski = await rpc("kalip_foto_ayarla", { p_id: kalipId, p_yol: yol }); }
    catch (e) { await sb.storage.from(DEPO).remove([yol]); throw e; }
    if (eski) sb.storage.from(DEPO).remove([eski]).catch(() => {});
  }

  async function fotoDegistir(k, dosya, detay) {
    const b = detay.q('[data-e="foto"]');
    await mesgulCalistir(detay, async () => {
      if (b) b.textContent = "Fotoğraf küçültülüyor ve yükleniyor…";
      try {
        await fotoYukle(k.id, dosya);
        bildir("Fotoğraf kaydedildi");
      } catch (e) {
        bildir("Fotoğraf kaydedilemedi: " + e.message + " Mevcut fotoğraf değişmedi.", true);
      }
    });
    detay.yenile();
  }

  /* ---------------- Arşiv (Yönetim) ---------------- */
  async function arsivle(k, detay) {
    const ok = await onayIste({
      baslik: "Arşive al", buton: "Arşive al", tehlike: true,
      metin: `<strong>${esc(k.urun_adi)}</strong> aktif listelerden kaldırılıp fotoğrafı ve geçmişiyle birlikte arşive taşınacak.` +
        (k.acik_gonderim_id ? `<br><br>Kalıp şu an <strong>${esc(k.mevcut_tedarikci_ad)}</strong> tedarikçisinde; bu bilgi arşivde korunur.` : "") +
        `<br><br>Arşivden istediğiniz zaman geri getirebilirsiniz.`,
    });
    if (!ok) return;
    await mesgulCalistir(detay, async () => {
      try { await rpc("kalip_arsivle", { p_id: k.id }); }
      catch (e) { bildir(e.message, true); return; }
      detay.kapat();
      bildir("Kalıp arşive alındı");
      verileriYukle(true);
    });
  }

  async function arsivdenGetir(k, detay) {
    await mesgulCalistir(detay, async () => {
      try { await rpc("kalip_arsivden_getir", { p_id: k.id }); }
      catch (e) { bildir(e.message, true); return; }
      bildir(k.acik_gonderim_id ? "Kalıp aktif listeye döndü (Dışarıda)" : "Kalıp aktif listeye döndü (Rafta)");
      detay.kapat();
      verileriYukle(true);
      arsivListesiniYenile();
    });
  }

  async function kaliciSil(k, detay) {
    const ok1 = await onayIste({
      baslik: "Kalıcı sil", buton: "Devam", tehlike: true,
      metin: `<strong>${esc(k.urun_adi)}</strong> kalıcı olarak silinecek:<br>• kalıp kaydı<br>• fotoğrafı<br>• bütün gönderim / dönüş geçmişi<br><br>Bu işlem geri alınamaz.`,
    });
    if (!ok1) return;
    const ok2 = await onayIste({
      baslik: "Son onay", buton: "Kalıcı olarak sil", tehlike: true,
      metin: `<strong>${esc(k.urun_adi)}</strong> ve bütün geçmişi silinsin mi? Bu son onaydır.`,
    });
    if (!ok2) return;
    await mesgulCalistir(detay, async () => {
      let foto;
      try { foto = await rpc("kalip_kalici_sil", { p_id: k.id }); }
      catch (e) { bildir("Silinemedi: " + e.message + " Kayıtlarda değişiklik olmadı.", true); return; }
      // Veritabanı kaydı tek işlemde silindi; fotoğraf dosyası ardından kaldırılır
      if (foto) sb.storage.from(DEPO).remove([foto]).catch(() => {});
      detay.kapat();
      bildir("Kalıp kalıcı olarak silindi");
      arsivListesiniYenile();
    });
  }

  let arsivPenceresiRef = null;
  async function arsivPenceresi() {
    const p = pencereAc({ baslik: "Arşiv", govde: `<div class="liste-bos">Yükleniyor…</div>` });
    arsivPenceresiRef = p;
    p.onKapat = () => { arsivPenceresiRef = null; };
    await arsivListesiniYenile();
  }
  async function arsivListesiniYenile() {
    const p = arsivPenceresiRef;
    if (!p || !p.el.isConnected) return;
    let liste;
    try { liste = await sorgu(sb.from("kalip_durumlari").select("*").eq("arsivde", true).order("urun_adi")); }
    catch (e) { p.govde.innerHTML = `<p class="form-hata">Arşiv yüklenemedi: ${esc(e.message)}</p>`; return; }
    p.baslik(`Arşiv (${liste.length})`);
    p.govde.innerHTML = liste.length ? `<div class="satir-liste">${liste.map(k => `
        <button type="button" class="kart-kalip" data-arsiv="${esc(k.id)}">
          <div class="k-ad">${esc(k.urun_adi)}</div>
          <div class="k-alt"><span>${esc(parcaYaz(k.parca_sayisi))}</span>
            <span>${k.acik_gonderim_id ? `Dışarıda · <span class="k-ted">${esc(k.mevcut_tedarikci_ad)}</span>` : "Rafta"}</span>
            <span>Arşiv: ${esc(tarihSaat(k.arsiv_zamani))}</span></div>
        </button>`).join("")}</div>`
      : `<p class="not">Arşivde kalıp yok.</p>`;
    p.govde.querySelectorAll("[data-arsiv]").forEach(b => b.onclick = () => detayAc(b.dataset.arsiv));
  }

  /* ---------------- Tedarikçiler (Yönetim) ---------------- */
  async function tedarikciPenceresi() {
    const p = pencereAc({
      baslik: "Tedarikçiler",
      govde: `<form class="ekle-satir" id="tEkle"><input type="text" name="ad" maxlength="100" placeholder="Yeni tedarikçi adı" required>
                <button type="submit" class="btn ana">Ekle</button></form>
              <p class="form-hata" hidden></p>
              <div class="satir-liste" id="tListe"></div>
              <p class="not" style="margin-top:12px">Hiç kullanılmamış tedarikçi kalıcı silinir. Geçmişte kullanılmış tedarikçi
                yeni gönderim listesinden kaldırılır, geçmiş kayıtlar korunur.</p>`,
    });
    const hata = p.q(".form-hata");
    const goster = (m) => { hata.textContent = m; hata.hidden = !m; };
    const ciz = () => {
      p.q("#tListe").innerHTML = tedarikciler.length ? tedarikciler.map(t => `
        <div class="satir" data-t="${esc(t.id)}">
          <span class="s-ad">${esc(t.ad)}</span>
          <button type="button" class="btn kucuk sade" data-i="duzenle">Adını düzenle</button>
          <button type="button" class="btn kucuk tehlike" data-i="sil">Sil</button>
        </div>`).join("") : `<p class="not">Henüz tedarikçi yok.</p>`;
      p.q("#tListe").querySelectorAll(".satir").forEach(satir => {
        const t = tedarikciler.find(x => x.id === satir.dataset.t);
        satir.querySelector('[data-i="duzenle"]').onclick = () => duzenle(satir, t);
        satir.querySelector('[data-i="sil"]').onclick = () => sil(t);
      });
    };
    const yenile = async () => {
      try { tedarikciler = await sorgu(sb.from("tedarikciler").select("id, ad").eq("aktif", true).order("ad")); }
      catch (e) { goster("Liste yüklenemedi: " + e.message); }
      ciz();
      verileriYukle(true);
    };
    const duzenle = (satir, t) => {
      satir.innerHTML = `<input type="text" maxlength="100" value="${esc(t.ad)}">
        <button type="button" class="btn kucuk ana" data-i="kaydet">Kaydet</button>
        <button type="button" class="btn kucuk sade" data-i="iptal">İptal</button>`;
      const girdi = satir.querySelector("input");
      girdi.focus(); girdi.select();
      satir.querySelector('[data-i="iptal"]').onclick = ciz;
      const kaydet = () => mesgulCalistir(p, async () => {
        goster("");
        try { await rpc("tedarikci_adini_degistir", { p_id: t.id, p_ad: girdi.value }); }
        catch (e) { goster(e.message); return; }
        bildir("Tedarikçi adı güncellendi");
        await yenile();
      });
      satir.querySelector('[data-i="kaydet"]').onclick = kaydet;
      girdi.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); kaydet(); } if (e.key === "Escape") { e.stopPropagation(); ciz(); } };
    };
    const sil = async (t) => {
      const ok = await onayIste({
        baslik: "Tedarikçiyi sil", buton: "Sil", tehlike: true,
        metin: `<strong>${esc(t.ad)}</strong> silinsin mi?<br><br>Geçmişte kullanıldıysa geçmiş kayıtlar korunur ve yalnızca yeni gönderim listesinden kaldırılır.`,
      });
      if (!ok) return;
      await mesgulCalistir(p, async () => {
        goster("");
        let sonuc;
        try { sonuc = await rpc("tedarikci_sil", { p_id: t.id }); }
        catch (e) { goster(e.message); return; }
        bildir(sonuc === "silindi" ? "Tedarikçi kalıcı olarak silindi" : "Tedarikçi listeden kaldırıldı; geçmiş kayıtlar korundu");
        await yenile();
      });
    };
    p.q("#tEkle").onsubmit = (e) => {
      e.preventDefault();
      const girdi = e.target.ad;
      mesgulCalistir(p, async () => {
        goster("");
        try { await rpc("tedarikci_ekle", { p_ad: girdi.value }); }
        catch (err) { goster(err.message); return; }
        girdi.value = "";
        bildir("Tedarikçi eklendi");
        await yenile();
      }).then(() => girdi.focus());
    };
    await yenile();
  }

  /* ---------------- Excel'e aktar ---------------- */
  let exceljsYukleniyor = null;
  function exceljsYukle() {
    if (window.ExcelJS) return Promise.resolve();
    if (!exceljsYukleniyor) exceljsYukleniyor = new Promise((coz, red) => {
      const s = document.createElement("script");
      s.src = EXCELJS_URL;
      s.onload = () => coz();
      s.onerror = () => { exceljsYukleniyor = null; red(new Error("Excel aracı yüklenemedi. İnternet bağlantısını kontrol edin.")); };
      document.head.appendChild(s);
    });
    return exceljsYukleniyor;
  }

  // Excel sayfa adı: en fazla 31 karakter, : \ / ? * [ ] yok, baş/sonda ' yok, benzersiz
  function sayfaAdiUret(ad, kullanilan) {
    const anahtar = (x) => [x.toLowerCase(), x.toLocaleLowerCase("tr-TR").replace(/ı/g, "i")];
    const temizle = (x) => x.replace(/^'+|'+$/g, "").trim();
    let s = temizle(String(ad || "").replace(/[\u0000-\u001f:\\\/\?\*\[\]]/g, " ").replace(/\s+/g, " ").trim());
    s = temizle(s.slice(0, 31)) || "Kalıp";
    let aday = s, i = 2;
    while (anahtar(aday).some(a => kullanilan.has(a)) || anahtar(aday).includes("history")) {
      const ek = ` (${i++})`;
      aday = temizle(s.slice(0, 31 - ek.length)) + ek;
    }
    anahtar(aday).forEach(a => kullanilan.add(a));
    return aday;
  }

  // Excel tarihleri saat dilimi bilmez; yerel saati korumak için kaydır
  const excelTarih = (iso) => { if (!iso) return null; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000); };
  const TARIH_BICIMI = "dd.mm.yyyy hh:mm";

  async function excelAktar(btn) {
    if (btn.disabled) return;
    const metin = btn.textContent;
    btn.disabled = true; btn.textContent = "Hazırlanıyor…";
    try {
      await exceljsYukle();
      const tumu = yon();
      let kq = sb.from("kalip_durumlari").select("*").order("urun_adi");
      if (!tumu) kq = kq.eq("arsivde", false);
      const [liste, hareketler] = await Promise.all([
        sorgu(kq),
        sorgu(sb.from("gonderimler").select("*, tedarikciler(ad)").order("gonderme_zamani")),
      ]);
      const gecmisi = {};
      hareketler.forEach(g => (gecmisi[g.kalip_id] = gecmisi[g.kalip_id] || []).push(g));

      const simdi = new Date();
      const wb = new ExcelJS.Workbook();
      wb.creator = "Tümersan"; wb.created = simdi;
      const LACIVERT = "FF1B2A6B";
      const baslikStili = (row) => { row.font = { bold: true, color: { argb: "FFFFFFFF" } }; row.eachCell(c => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LACIVERT } }; }); };
      const sutunStili = (row) => { row.font = { bold: true }; row.eachCell(c => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3E5EA" } }; }); };
      const sonUretimHucre = (k) => !k.tamamlanan_var ? "" : (k.son_uretim_adedi == null ? "Belirtilmedi" : k.son_uretim_adedi);
      const konumYaz = (k) => (k.arsivde ? "Arşivde – " : "") + (k.acik_gonderim_id ? "Dışarıda" : "Rafta");

      // --- Genel Durum ---
      const kullanilan = new Set();
      const genel = wb.addWorksheet(sayfaAdiUret("Genel Durum", kullanilan));
      genel.columns = [{ width: 32 }, { width: 36 }, { width: 13 }, { width: 20 }, { width: 26 }, { width: 18 }, { width: 18 }];
      genel.addRow(["Kalıp Takibi – Genel Durum"]).font = { bold: true, size: 14, color: { argb: LACIVERT } };
      const r2 = genel.addRow(["Dışa aktarma tarihi ve saati", excelTarih(simdi.toISOString())]);
      r2.getCell(2).numFmt = TARIH_BICIMI; r2.getCell(1).font = { bold: true };
      genel.addRow([tumu ? "Kapsam: aktif ve arşivdeki kalıplar (Yönetim)" : "Kapsam: aktif kalıplar"]).font = { italic: true, color: { argb: "FF8B9099" } };
      const bolumYaz = (baslik, kayitlar) => {
        genel.addRow([]);
        const b = genel.addRow([`${baslik} (${kayitlar.length})`, "", "", "", "", "", ""]); baslikStili(b);
        sutunStili(genel.addRow(["Ürün adı", "Açıklama", "Parça sayısı", "Konum", "Mevcut tedarikçi", "Gönderme tarihi", "Son üretim adedi"]));
        if (!kayitlar.length) { genel.addRow(["Kayıt yok"]).font = { italic: true }; return; }
        kayitlar.forEach(k => {
          const r = genel.addRow([k.urun_adi, k.aciklama || "", k.parca_sayisi, konumYaz(k), k.mevcut_tedarikci_ad || "",
            k.acik_gonderim_id ? excelTarih(k.mevcut_gonderme_zamani) : "", sonUretimHucre(k)]);
          r.getCell(6).numFmt = TARIH_BICIMI;
          if (typeof r.getCell(7).value === "number") r.getCell(7).numFmt = "#,##0";
          r.alignment = { vertical: "top", wrapText: true };
        });
      };
      const aktif = liste.filter(k => !k.arsivde);
      bolumYaz("Raftaki Kalıplar", aktif.filter(k => !k.acik_gonderim_id));
      bolumYaz("Dışarıdaki Kalıplar", aktif.filter(k => k.acik_gonderim_id));
      if (tumu) bolumYaz("Arşivdeki Kalıplar", liste.filter(k => k.arsivde));

      // --- Her kalıp için ayrı sayfa (aktifler önce, sonra arşiv) ---
      const sirali = [...aktif, ...liste.filter(k => k.arsivde)];
      sirali.forEach(k => {
        const ws = wb.addWorksheet(sayfaAdiUret(k.urun_adi, kullanilan));
        ws.columns = [{ width: 24 }, { width: 18 }, { width: 18 }, { width: 30 }, { width: 18 }, { width: 18 }, { width: 30 }, { width: 15 }];
        ws.addRow([k.urun_adi]).font = { bold: true, size: 14, color: { argb: LACIVERT } };
        const bilgi = [
          ["Durum", k.arsivde ? "Arşivde" : "Aktif"],
          ["Açıklama", k.aciklama || ""],
          ["Parça sayısı", k.parca_sayisi],
          ["Konum", konumYaz(k)],
          ["Mevcut tedarikçi", k.mevcut_tedarikci_ad || ""],
          ["Mevcut gönderme tarihi", k.acik_gonderim_id ? excelTarih(k.mevcut_gonderme_zamani) : ""],
          ["Son üretim adedi", sonUretimHucre(k)],
          ["Dışa aktarma", excelTarih(simdi.toISOString())],
        ];
        bilgi.forEach(([a, v]) => {
          const r = ws.addRow([a, v]);
          r.getCell(1).font = { bold: true };
          if (v instanceof Date) r.getCell(2).numFmt = TARIH_BICIMI;
          if (a === "Son üretim adedi" && typeof v === "number") r.getCell(2).numFmt = "#,##0";
          r.getCell(2).alignment = { wrapText: true, vertical: "top", horizontal: "left" };
        });
        ws.addRow([]);
        baslikStili(ws.addRow(["Gönderim / dönüş geçmişi", "", "", "", "", "", "", ""]));
        sutunStili(ws.addRow(["Tedarikçi", "Gönderme tarihi", "Gönderen", "Gönderme açıklaması", "Dönüş tarihi", "Geri alan", "Dönüş açıklaması", "Üretim adedi"]));
        const gs = gecmisi[k.id] || [];
        if (!gs.length) ws.addRow(["Henüz gönderim yok."]).font = { italic: true };
        gs.forEach(g => {
          const dondu = !!g.donus_zamani;
          const r = ws.addRow([
            (g.tedarikciler && g.tedarikciler.ad) || "", excelTarih(g.gonderme_zamani), g.gonderen_ad || "", g.gonderme_aciklama || "",
            dondu ? excelTarih(g.donus_zamani) : "", dondu ? (g.geri_alan_ad || "") : "", dondu ? (g.donus_aciklama || "") : "",
            dondu ? (g.uretim_adedi == null ? "Belirtilmedi" : g.uretim_adedi) : "",
          ]);
          r.getCell(2).numFmt = TARIH_BICIMI; r.getCell(5).numFmt = TARIH_BICIMI;
          if (typeof r.getCell(8).value === "number") r.getCell(8).numFmt = "#,##0";
          r.alignment = { vertical: "top", wrapText: true };
        });
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `Kalip_Takibi_${simdi.getFullYear()}-${iki(simdi.getMonth() + 1)}-${iki(simdi.getDate())}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      bildir("Excel dosyası indirildi");
    } catch (e) {
      bildir("Excel dosyası oluşturulamadı: " + hataMetni(e), true);
    } finally {
      btn.disabled = false; btn.textContent = metin;
    }
  }

  /* ---------------- Aç / kapat ---------------- */
  function ac() {
    if (acik) return;
    acik = true;
    iskeletKur();
    verileriYukle();
    // Farklı cihazlardaki değişiklikleri görmek için düzenli yenile (pencere açıkken bekler)
    yenilemeZamanlayici = setInterval(() => {
      if (!document.hidden && !document.querySelector(".perde")) verileriYukle(true);
    }, 30000);
  }
  function kapat() {
    if (!acik) return;
    acik = false;
    clearInterval(yenilemeZamanlayici);
    tumPencereleriKapat();
    $("#kalipSayfa").innerHTML = "";
  }
  document.addEventListener("visibilitychange", () => {
    if (acik && !document.hidden && !document.querySelector(".perde")) verileriYukle(true);
  });

  window.Kalip = { ac, kapat, _test: { sayfaAdiUret, adetOku } };
  if (typeof sayfaGoster === "function") sayfaGoster();
})();
