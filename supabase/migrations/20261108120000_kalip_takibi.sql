-- =====================================================================
-- KALIP TAKİBİ - ilk sürüm
--   Tablolar: tedarikciler, kaliplar, gonderimler, degisiklik_kaydi
--   Konum ve son üretim, gönderim geçmişinden hesaplanır (kalip_durumlari görünümü),
--   böylece geçmiş ile mevcut durum her zaman tutarlıdır.
--   Bütün yazma işlemleri yetki kontrollü fonksiyonlarla yapılır; tablolara
--   doğrudan ekleme / değiştirme / silme izni yoktur.
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- Yetki yardımcıları (Supabase kullanıcısının app_metadata.bolumler listesi)
-- ---------------------------------------------------------------------
create or replace function public.bolumlerim() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' -> 'bolumler', '[]'::jsonb)
$$;

create or replace function public.yonetim_mi() returns boolean
language sql stable set search_path = '' as $$
  select public.bolumlerim() ? 'yonetim'
$$;

create or replace function public.kullanici_mi() returns boolean
language sql stable set search_path = '' as $$
  select public.bolumlerim() ?| array['yonetim', 'uretim']
$$;

create or replace function public.ben_ad() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'gorunen_ad', ''),
                  split_part(auth.jwt() ->> 'email', '@', 1))
$$;

-- ---------------------------------------------------------------------
-- Tablolar
-- ---------------------------------------------------------------------
create table public.tedarikciler (
  id          uuid primary key default gen_random_uuid(),
  ad          text not null check (length(btrim(ad)) between 1 and 100),
  aktif       boolean not null default true,   -- false: yeni gönderim listesinden kaldırıldı, geçmiş korunur
  olusturma   timestamptz not null default now()
);
create unique index tedarikciler_ad_tekil on public.tedarikciler (lower(btrim(ad))) where aktif;

create table public.kaliplar (
  id            uuid primary key default gen_random_uuid(),   -- değişmeyen sistem kimliği
  urun_adi      text not null check (length(btrim(urun_adi)) between 1 and 150),
  aciklama      text check (aciklama is null or length(aciklama) <= 2000),
  parca_sayisi  integer not null check (parca_sayisi > 0),
  foto_yolu     text,
  arsivde       boolean not null default false,
  arsiv_zamani  timestamptz,
  olusturan_id  uuid,
  olusturan_ad  text,
  olusturma     timestamptz not null default now(),
  guncelleme    timestamptz not null default now()
);

create table public.gonderimler (
  id                 uuid primary key default gen_random_uuid(),
  kalip_id           uuid not null references public.kaliplar(id) on delete cascade,
  tedarikci_id       uuid not null references public.tedarikciler(id) on delete restrict,
  gonderme_zamani    timestamptz not null default now(),
  gonderen_id        uuid,
  gonderen_ad        text not null,
  gonderme_aciklama  text check (gonderme_aciklama is null or length(gonderme_aciklama) <= 1000),
  donus_zamani       timestamptz,                 -- boş: kalıp hâlâ bu tedarikçide
  geri_alan_id       uuid,
  geri_alan_ad       text,
  donus_aciklama     text check (donus_aciklama is null or length(donus_aciklama) <= 1000),
  uretim_adedi       integer check (uretim_adedi is null or uretim_adedi >= 0),  -- boş = Belirtilmedi
  duzeltme_zamani    timestamptz,
  constraint donus_gonderimden_once_olamaz
    check (donus_zamani is null or donus_zamani >= gonderme_zamani),
  constraint acik_gonderimde_donus_bilgisi_olmaz
    check (donus_zamani is not null or (geri_alan_id is null and geri_alan_ad is null
                                        and donus_aciklama is null and uretim_adedi is null)),
  -- Aynı kalıbın gönderimleri zaman olarak üst üste binemez
  constraint gonderimler_cakismaz exclude using gist (
    kalip_id with =,
    tstzrange(gonderme_zamani, coalesce(donus_zamani, 'infinity'::timestamptz), '[)') with &&
  )
);
-- Bir kalıbın aynı anda en fazla bir açık gönderimi olabilir (eşzamanlı işlemlere karşı)
create unique index gonderimler_tek_acik on public.gonderimler (kalip_id) where donus_zamani is null;
create index gonderimler_tedarikci on public.gonderimler (tedarikci_id);

-- Değişiklik kaydı: tedarikçi adı, kalıp bilgisi, geçmiş düzeltmeleri, arşiv işlemleri
create table public.degisiklik_kaydi (
  id        bigint generated always as identity primary key,
  tablo     text not null,
  kayit_id  uuid not null,
  islem     text not null,
  eski      jsonb,
  yeni      jsonb,
  yapan_id  uuid,
  yapan_ad  text,
  zaman     timestamptz not null default now()
);
create index degisiklik_kaydi_kayit on public.degisiklik_kaydi (kayit_id);

-- ---------------------------------------------------------------------
-- Görünüm: her kalıbın mevcut durumu (RLS'e tabi)
-- ---------------------------------------------------------------------
create view public.kalip_durumlari with (security_invoker = true) as
select k.id, k.urun_adi, k.aciklama, k.parca_sayisi, k.foto_yolu, k.arsivde, k.arsiv_zamani, k.olusturma,
       a.id               as acik_gonderim_id,
       a.tedarikci_id     as mevcut_tedarikci_id,
       at.ad              as mevcut_tedarikci_ad,
       a.gonderme_zamani  as mevcut_gonderme_zamani,
       s.tedarikci_ad     as son_tedarikci_ad,
       (t.id is not null) as tamamlanan_var,
       t.uretim_adedi     as son_uretim_adedi,
       t.donus_zamani     as son_donus_zamani
from public.kaliplar k
left join public.gonderimler a on a.kalip_id = k.id and a.donus_zamani is null
left join public.tedarikciler at on at.id = a.tedarikci_id
left join lateral (
  select td.ad as tedarikci_ad
  from public.gonderimler g join public.tedarikciler td on td.id = g.tedarikci_id
  where g.kalip_id = k.id order by g.gonderme_zamani desc limit 1
) s on true
left join lateral (
  select g.id, g.uretim_adedi, g.donus_zamani
  from public.gonderimler g
  where g.kalip_id = k.id and g.donus_zamani is not null
  order by g.donus_zamani desc limit 1
) t on true;

-- ---------------------------------------------------------------------
-- Satır güvenliği (RLS): yalnızca okuma politikaları
-- ---------------------------------------------------------------------
alter table public.tedarikciler     enable row level security;
alter table public.kaliplar         enable row level security;
alter table public.gonderimler      enable row level security;
alter table public.degisiklik_kaydi enable row level security;

create policy "tedarikciler okuma" on public.tedarikciler
  for select to authenticated using (public.kullanici_mi());

-- Üretim arşivdeki kalıpları göremez
create policy "kaliplar okuma" on public.kaliplar
  for select to authenticated using (public.kullanici_mi() and (not arsivde or public.yonetim_mi()));

create policy "gonderimler okuma" on public.gonderimler
  for select to authenticated using (
    public.kullanici_mi() and exists (select 1 from public.kaliplar k where k.id = kalip_id));

create policy "degisiklik kaydi okuma" on public.degisiklik_kaydi
  for select to authenticated using (public.yonetim_mi());

revoke all on public.tedarikciler, public.kaliplar, public.gonderimler,
              public.degisiklik_kaydi, public.kalip_durumlari from anon, authenticated;
grant select on public.tedarikciler, public.kaliplar, public.gonderimler,
                public.degisiklik_kaydi, public.kalip_durumlari to authenticated;

-- ---------------------------------------------------------------------
-- İşlem fonksiyonları
-- ---------------------------------------------------------------------
create or replace function public._yetki_yonetim() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not public.yonetim_mi() then
    raise exception 'Bu işlem yalnızca Yönetim yetkisiyle yapılabilir.';
  end if;
end $$;

create or replace function public._yetki_kullanici() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not public.kullanici_mi() then
    raise exception 'Bu işlem için yetkiniz yok.';
  end if;
end $$;

create or replace function public._kayit(p_tablo text, p_id uuid, p_islem text, p_eski jsonb, p_yeni jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.degisiklik_kaydi (tablo, kayit_id, islem, eski, yeni, yapan_id, yapan_ad)
  values (p_tablo, p_id, p_islem, p_eski, p_yeni, auth.uid(), public.ben_ad());
$$;

create or replace function public._metin(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(p), '')
$$;

-- ---------- Kalıp ----------
create or replace function public.kalip_olustur(p_urun_adi text, p_aciklama text, p_parca_sayisi integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public._yetki_yonetim();
  if public._metin(p_urun_adi) is null then raise exception 'Ürün adı zorunludur.'; end if;
  if p_parca_sayisi is null or p_parca_sayisi < 1 then raise exception 'Parça sayısı pozitif tam sayı olmalıdır.'; end if;
  insert into public.kaliplar (urun_adi, aciklama, parca_sayisi, olusturan_id, olusturan_ad)
  values (public._metin(p_urun_adi), public._metin(p_aciklama), p_parca_sayisi, auth.uid(), public.ben_ad())
  returning id into v_id;
  perform public._kayit('kaliplar', v_id, 'olustur', null,
    jsonb_build_object('urun_adi', public._metin(p_urun_adi), 'parca_sayisi', p_parca_sayisi));
  return v_id;
end $$;

create or replace function public.kalip_guncelle(p_id uuid, p_urun_adi text, p_aciklama text, p_parca_sayisi integer)
returns void language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar;
begin
  perform public._yetki_yonetim();
  if public._metin(p_urun_adi) is null then raise exception 'Ürün adı zorunludur.'; end if;
  if p_parca_sayisi is null or p_parca_sayisi < 1 then raise exception 'Parça sayısı pozitif tam sayı olmalıdır.'; end if;
  select * into k from public.kaliplar where id = p_id for update;
  if not found then raise exception 'Kalıp bulunamadı. Başka bir kullanıcı silmiş olabilir.'; end if;
  update public.kaliplar
     set urun_adi = public._metin(p_urun_adi), aciklama = public._metin(p_aciklama),
         parca_sayisi = p_parca_sayisi, guncelleme = now()
   where id = p_id;
  perform public._kayit('kaliplar', p_id, 'duzenle',
    jsonb_build_object('urun_adi', k.urun_adi, 'aciklama', k.aciklama, 'parca_sayisi', k.parca_sayisi),
    jsonb_build_object('urun_adi', public._metin(p_urun_adi), 'aciklama', public._metin(p_aciklama),
                       'parca_sayisi', p_parca_sayisi));
end $$;

-- Yeni fotoğraf depoya yüklendikten SONRA çağrılır; eski yolu döndürür (istemci eskiyi siler)
create or replace function public.kalip_foto_ayarla(p_id uuid, p_yol text)
returns text language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar;
begin
  perform public._yetki_yonetim();
  if p_yol is null or split_part(p_yol, '/', 1) <> p_id::text then raise exception 'Geçersiz fotoğraf yolu.'; end if;
  select * into k from public.kaliplar where id = p_id for update;
  if not found then raise exception 'Kalıp bulunamadı. Başka bir kullanıcı silmiş olabilir.'; end if;
  update public.kaliplar set foto_yolu = p_yol, guncelleme = now() where id = p_id;
  perform public._kayit('kaliplar', p_id, 'foto', jsonb_build_object('foto_yolu', k.foto_yolu),
                        jsonb_build_object('foto_yolu', p_yol));
  return k.foto_yolu;
end $$;

create or replace function public.kalip_arsivle(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar;
begin
  perform public._yetki_yonetim();
  select * into k from public.kaliplar where id = p_id for update;
  if not found then raise exception 'Kalıp bulunamadı. Başka bir kullanıcı silmiş olabilir.'; end if;
  if k.arsivde then raise exception 'Bu kalıp zaten arşivde.'; end if;
  -- Açık gönderim olduğu gibi kalır: kalıbın hangi tedarikçide olduğu korunur, rafa dönüş hareketi üretilmez
  update public.kaliplar set arsivde = true, arsiv_zamani = now(), guncelleme = now() where id = p_id;
  perform public._kayit('kaliplar', p_id, 'arsivle', null, null);
end $$;

create or replace function public.kalip_arsivden_getir(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar;
begin
  perform public._yetki_yonetim();
  select * into k from public.kaliplar where id = p_id for update;
  if not found then raise exception 'Kalıp bulunamadı. Başka bir kullanıcı silmiş olabilir.'; end if;
  if not k.arsivde then raise exception 'Bu kalıp zaten aktif listede.'; end if;
  update public.kaliplar set arsivde = false, arsiv_zamani = null, guncelleme = now() where id = p_id;
  perform public._kayit('kaliplar', p_id, 'arsivden_getir', null, null);
end $$;

-- Yalnızca arşivdeki kalıp kalıcı silinebilir. Tek işlemde (transaction) kalıp, geçmişi ve
-- değişiklik kayıtları silinir; fotoğraf yolu döndürülür, istemci depodan siler.
create or replace function public.kalip_kalici_sil(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar;
begin
  perform public._yetki_yonetim();
  select * into k from public.kaliplar where id = p_id for update;
  if not found then raise exception 'Kalıp bulunamadı. Daha önce silinmiş olabilir.'; end if;
  if not k.arsivde then raise exception 'Kalıcı silmeden önce kalıp arşive alınmalıdır.'; end if;
  delete from public.degisiklik_kaydi
   where kayit_id = p_id or kayit_id in (select id from public.gonderimler where kalip_id = p_id);
  delete from public.kaliplar where id = p_id;   -- gönderimler cascade ile silinir
  perform public._kayit('kaliplar', p_id, 'kalici_sil', jsonb_build_object('urun_adi', k.urun_adi), null);
  return k.foto_yolu;
end $$;

-- ---------- Gönderme / geri alma ----------
create or replace function public.kalip_gonder(p_kalip_id uuid, p_tedarikci_id uuid, p_aciklama text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar; v_id uuid;
begin
  perform public._yetki_kullanici();
  select * into k from public.kaliplar where id = p_kalip_id for update;   -- aynı kalıba eşzamanlı işlemleri sıraya koyar
  if not found then raise exception 'Kalıp bulunamadı. Başka bir kullanıcı silmiş olabilir.'; end if;
  if k.arsivde then raise exception 'Arşivdeki kalıp gönderilemez.'; end if;
  if exists (select 1 from public.gonderimler where kalip_id = p_kalip_id and donus_zamani is null) then
    raise exception 'Bu kalıp zaten dışarıda. Başka bir kullanıcı göndermiş olabilir; liste güncellendi.';
  end if;
  if not exists (select 1 from public.tedarikciler where id = p_tedarikci_id and aktif) then
    raise exception 'Seçilen tedarikçi artık listede değil. Listeyi yenileyip tekrar seçin.';
  end if;
  begin
    insert into public.gonderimler (kalip_id, tedarikci_id, gonderme_zamani, gonderen_id, gonderen_ad, gonderme_aciklama)
    values (p_kalip_id, p_tedarikci_id, now(), auth.uid(), public.ben_ad(), public._metin(p_aciklama))
    returning id into v_id;
  exception when exclusion_violation or unique_violation then
    raise exception 'Bu kalıbın kayıtlı bir dönüş tarihi şu andan sonra görünüyor. Geçmişteki tarihleri kontrol edin.';
  end;
  return v_id;
end $$;

create or replace function public.kalip_geri_al(p_kalip_id uuid, p_uretim_adedi integer, p_aciklama text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar; g public.gonderimler;
begin
  perform public._yetki_kullanici();
  if p_uretim_adedi is not null and p_uretim_adedi < 0 then
    raise exception 'Üretim adedi sıfır veya daha büyük bir tam sayı olmalıdır.';
  end if;
  select * into k from public.kaliplar where id = p_kalip_id for update;
  if not found then raise exception 'Kalıp bulunamadı. Başka bir kullanıcı silmiş olabilir.'; end if;
  if k.arsivde then raise exception 'Arşivdeki kalıp rafa alınamaz. Önce arşivden geri getirin.'; end if;
  select * into g from public.gonderimler where kalip_id = p_kalip_id and donus_zamani is null for update;
  if not found then
    raise exception 'Bu kalıp zaten rafta. Başka bir kullanıcı geri almış olabilir; liste güncellendi.';
  end if;
  update public.gonderimler
     set donus_zamani = greatest(now(), g.gonderme_zamani), geri_alan_id = auth.uid(), geri_alan_ad = public.ben_ad(),
         donus_aciklama = public._metin(p_aciklama), uretim_adedi = p_uretim_adedi
   where id = g.id;
  return g.id;
end $$;

-- ---------- Geçmiş düzeltme (yalnızca Yönetim) ----------
create or replace function public.gonderim_duzelt(
  p_id uuid, p_tedarikci_id uuid, p_gonderme_zamani timestamptz, p_gonderme_aciklama text,
  p_donus_zamani timestamptz, p_donus_aciklama text, p_uretim_adedi integer)
returns void language plpgsql security definer set search_path = '' as $$
declare g public.gonderimler; v_eski jsonb := '{}'; v_yeni jsonb := '{}';
begin
  perform public._yetki_yonetim();
  select * into g from public.gonderimler where id = p_id;
  if not found then raise exception 'Gönderim kaydı bulunamadı. Silinmiş olabilir.'; end if;
  perform 1 from public.kaliplar where id = g.kalip_id for update;      -- kalıp işlemleriyle sıraya gir
  select * into g from public.gonderimler where id = p_id for update;   -- kilitledikten sonra güncel hali

  if p_gonderme_zamani is null then raise exception 'Gönderme tarihi zorunludur.'; end if;
  if p_gonderme_zamani > now() + interval '1 minute' then raise exception 'Gönderme tarihi ileri bir tarih olamaz.'; end if;
  if not exists (select 1 from public.tedarikciler where id = p_tedarikci_id and (aktif or id = g.tedarikci_id)) then
    raise exception 'Seçilen tedarikçi listede değil.';
  end if;

  if g.donus_zamani is null then
    -- Açık gönderim: dönüş bilgisi düzeltme ile girilemez, rafa geri alma ile girilir
    if p_donus_zamani is not null or public._metin(p_donus_aciklama) is not null or p_uretim_adedi is not null then
      raise exception 'Kalıp hâlâ dışarıda; dönüş bilgisi Rafa geri al ile girilir.';
    end if;
  else
    if p_donus_zamani is null then raise exception 'Dönüş tarihi zorunludur.'; end if;
    if p_donus_zamani > now() + interval '1 minute' then raise exception 'Dönüş tarihi ileri bir tarih olamaz.'; end if;
    if p_donus_zamani < p_gonderme_zamani then raise exception 'Dönüş tarihi gönderme tarihinden önce olamaz.'; end if;
    if p_uretim_adedi is not null and p_uretim_adedi < 0 then
      raise exception 'Üretim adedi sıfır veya daha büyük bir tam sayı olmalıdır.';
    end if;
  end if;

  if g.tedarikci_id is distinct from p_tedarikci_id then
    v_eski := v_eski || jsonb_build_object('tedarikci_id', g.tedarikci_id,
              'tedarikci_ad', (select ad from public.tedarikciler where id = g.tedarikci_id));
    v_yeni := v_yeni || jsonb_build_object('tedarikci_id', p_tedarikci_id,
              'tedarikci_ad', (select ad from public.tedarikciler where id = p_tedarikci_id));
  end if;
  if g.gonderme_zamani is distinct from p_gonderme_zamani then
    v_eski := v_eski || jsonb_build_object('gonderme_zamani', g.gonderme_zamani);
    v_yeni := v_yeni || jsonb_build_object('gonderme_zamani', p_gonderme_zamani);
  end if;
  if g.gonderme_aciklama is distinct from public._metin(p_gonderme_aciklama) then
    v_eski := v_eski || jsonb_build_object('gonderme_aciklama', g.gonderme_aciklama);
    v_yeni := v_yeni || jsonb_build_object('gonderme_aciklama', public._metin(p_gonderme_aciklama));
  end if;
  if g.donus_zamani is not null then
    if g.donus_zamani is distinct from p_donus_zamani then
      v_eski := v_eski || jsonb_build_object('donus_zamani', g.donus_zamani);
      v_yeni := v_yeni || jsonb_build_object('donus_zamani', p_donus_zamani);
    end if;
    if g.donus_aciklama is distinct from public._metin(p_donus_aciklama) then
      v_eski := v_eski || jsonb_build_object('donus_aciklama', g.donus_aciklama);
      v_yeni := v_yeni || jsonb_build_object('donus_aciklama', public._metin(p_donus_aciklama));
    end if;
    if g.uretim_adedi is distinct from p_uretim_adedi then
      v_eski := v_eski || jsonb_build_object('uretim_adedi', g.uretim_adedi);
      v_yeni := v_yeni || jsonb_build_object('uretim_adedi', p_uretim_adedi);
    end if;
  end if;

  if v_yeni = '{}'::jsonb then return; end if;   -- değişiklik yok

  begin
    update public.gonderimler
       set tedarikci_id = p_tedarikci_id, gonderme_zamani = p_gonderme_zamani,
           gonderme_aciklama = public._metin(p_gonderme_aciklama),
           donus_zamani = case when g.donus_zamani is null then null else p_donus_zamani end,
           donus_aciklama = case when g.donus_zamani is null then null else public._metin(p_donus_aciklama) end,
           uretim_adedi = case when g.donus_zamani is null then null else p_uretim_adedi end,
           duzeltme_zamani = now()
     where id = p_id;
  exception when exclusion_violation then
    raise exception 'Bu tarihler aynı kalıbın başka bir gönderimiyle çakışıyor. Tarihleri kontrol edin.';
  end;
  perform public._kayit('gonderimler', p_id, 'duzelt', v_eski, v_yeni);
end $$;

-- ---------- Tedarikçi (yalnızca Yönetim) ----------
create or replace function public.tedarikci_ekle(p_ad text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public._yetki_yonetim();
  if public._metin(p_ad) is null then raise exception 'Tedarikçi adı zorunludur.'; end if;
  begin
    insert into public.tedarikciler (ad) values (public._metin(p_ad)) returning id into v_id;
  exception when unique_violation then
    raise exception 'Bu adla bir tedarikçi zaten var.';
  end;
  perform public._kayit('tedarikciler', v_id, 'ekle', null, jsonb_build_object('ad', public._metin(p_ad)));
  return v_id;
end $$;

create or replace function public.tedarikci_adini_degistir(p_id uuid, p_ad text)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tedarikciler;
begin
  perform public._yetki_yonetim();
  if public._metin(p_ad) is null then raise exception 'Tedarikçi adı zorunludur.'; end if;
  select * into t from public.tedarikciler where id = p_id and aktif for update;
  if not found then raise exception 'Tedarikçi bulunamadı. Silinmiş olabilir.'; end if;
  if t.ad = public._metin(p_ad) then return; end if;
  begin
    update public.tedarikciler set ad = public._metin(p_ad) where id = p_id;
  exception when unique_violation then
    raise exception 'Bu adla bir tedarikçi zaten var.';
  end;
  perform public._kayit('tedarikciler', p_id, 'ad_degistir', jsonb_build_object('ad', t.ad),
                        jsonb_build_object('ad', public._metin(p_ad)));
end $$;

-- 'silindi': hiç kullanılmamıştı, kalıcı silindi. 'kaldirildi': geçmişte kullanılmış, listeden kaldırıldı.
create or replace function public.tedarikci_sil(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare t public.tedarikciler; v_disarida int; v_adlar text;
begin
  perform public._yetki_yonetim();
  select * into t from public.tedarikciler where id = p_id and aktif for update;
  if not found then raise exception 'Tedarikçi bulunamadı. Silinmiş olabilir.'; end if;
  select count(*), string_agg(k.urun_adi || case when k.arsivde then ' (arşivde)' else '' end, ', ' order by k.urun_adi)
    into v_disarida, v_adlar
    from public.gonderimler g join public.kaliplar k on k.id = g.kalip_id
   where g.tedarikci_id = p_id and g.donus_zamani is null;
  if v_disarida > 0 then
    raise exception 'Bu tedarikçide şu an % kalıp var: %. Kalıplar rafa geri alınmadan tedarikçi silinemez.', v_disarida, v_adlar;
  end if;
  if exists (select 1 from public.gonderimler where tedarikci_id = p_id) then
    update public.tedarikciler set aktif = false where id = p_id;
    perform public._kayit('tedarikciler', p_id, 'listeden_kaldir', jsonb_build_object('ad', t.ad), null);
    return 'kaldirildi';
  end if;
  delete from public.degisiklik_kaydi where kayit_id = p_id;
  delete from public.tedarikciler where id = p_id;
  return 'silindi';
end $$;

-- Fonksiyon yetkileri: yalnızca giriş yapmış kullanıcılar çağırabilir (içeride ayrıca bölüm kontrolü var)
do $$
declare f text;
begin
  foreach f in array array[
    'bolumlerim()', 'yonetim_mi()', 'kullanici_mi()', 'ben_ad()',
    '_yetki_yonetim()', '_yetki_kullanici()', '_metin(text)',
    'kalip_olustur(text, text, integer)', 'kalip_guncelle(uuid, text, text, integer)',
    'kalip_foto_ayarla(uuid, text)', 'kalip_arsivle(uuid)', 'kalip_arsivden_getir(uuid)',
    'kalip_kalici_sil(uuid)', 'kalip_gonder(uuid, uuid, text)', 'kalip_geri_al(uuid, integer, text)',
    'gonderim_duzelt(uuid, uuid, timestamptz, text, timestamptz, text, integer)',
    'tedarikci_ekle(text)', 'tedarikci_adini_degistir(uuid, text)', 'tedarikci_sil(uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke all on function public._kayit(text, uuid, text, jsonb, jsonb) from public, anon, authenticated';
end $$;

-- ---------------------------------------------------------------------
-- Fotoğraf deposu (Supabase Storage)
--   Yol biçimi: <kalip_id>/<dosya>.jpg
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kalip-fotolari', 'kalip-fotolari', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "kalip foto okuma" on storage.objects for select to authenticated using (
  bucket_id = 'kalip-fotolari' and public.kullanici_mi()
  and exists (select 1 from public.kaliplar k where k.id::text = (storage.foldername(name))[1])  -- kaliplar RLS: üretim arşivi göremez
);
create policy "kalip foto yukleme" on storage.objects for insert to authenticated with check (
  bucket_id = 'kalip-fotolari' and public.yonetim_mi()
  and exists (select 1 from public.kaliplar k where k.id::text = (storage.foldername(name))[1])
);
create policy "kalip foto guncelleme" on storage.objects for update to authenticated
  using (bucket_id = 'kalip-fotolari' and public.yonetim_mi())
  with check (bucket_id = 'kalip-fotolari' and public.yonetim_mi());
create policy "kalip foto silme" on storage.objects for delete to authenticated using (
  bucket_id = 'kalip-fotolari' and public.yonetim_mi()
);
