-- =====================================================================
-- GÖNDERİM FİYATI (yalnızca Yönetim)
--   Fiyat, gonderimler tablosunda değil ayrı bir tabloda durur; bu tabloyu
--   yalnızca Yönetim okuyabilir. Üretimin sorgularında fiyat hiç dönmez.
--   Satır yok = fiyat girilmemiş (Belirtilmedi); 0 = sıfır fiyat.
--   Para birimi / birim-toplam henüz belirlenmediği için hesaplama yapılmaz.
-- =====================================================================

create table public.gonderim_fiyatlari (
  gonderim_id     uuid primary key references public.gonderimler(id) on delete cascade,
  fiyat           numeric(14, 2) not null check (fiyat >= 0),
  guncelleyen_id  uuid,
  guncelleyen_ad  text,
  guncelleme      timestamptz not null default now()
);

alter table public.gonderim_fiyatlari enable row level security;
create policy "gonderim fiyatlari yalnizca yonetim" on public.gonderim_fiyatlari
  for select to authenticated using (public.yonetim_mi());
revoke all on public.gonderim_fiyatlari from anon, authenticated;
grant select on public.gonderim_fiyatlari to authenticated;

create or replace function public._fiyat_dogrula(p_fiyat numeric) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_fiyat is null then return; end if;
  if p_fiyat < 0 then raise exception 'Fiyat sıfır veya daha büyük olmalıdır.'; end if;
  if p_fiyat <> round(p_fiyat, 2) then raise exception 'Fiyat en fazla iki ondalık basamaklı olmalıdır.'; end if;
  if p_fiyat >= 1e12 then raise exception 'Fiyat çok büyük.'; end if;
end $$;

-- Gönderme: fiyatı yalnızca Yönetim girebilir (Üretim fiyatsız gönderir)
drop function if exists public.kalip_gonder(uuid, uuid, text);
create or replace function public.kalip_gonder(p_kalip_id uuid, p_tedarikci_id uuid, p_aciklama text, p_fiyat numeric default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare k public.kaliplar; v_id uuid;
begin
  perform public._yetki_kullanici();
  if p_fiyat is not null and not public.yonetim_mi() then
    raise exception 'Fiyat yalnızca Yönetim tarafından girilebilir.';
  end if;
  perform public._fiyat_dogrula(p_fiyat);
  select * into k from public.kaliplar where id = p_kalip_id for update;
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
  if p_fiyat is not null then
    insert into public.gonderim_fiyatlari (gonderim_id, fiyat, guncelleyen_id, guncelleyen_ad)
    values (v_id, p_fiyat, auth.uid(), public.ben_ad());
    perform public._kayit('gonderim_fiyatlari', v_id, 'fiyat', null, jsonb_build_object('fiyat', p_fiyat));
  end if;
  return v_id;
end $$;

-- Mevcut veya tamamlanmış gönderimin fiyatını ekle / değiştir / kaldır (boş = kaldır)
create or replace function public.gonderim_fiyat_ayarla(p_gonderim_id uuid, p_fiyat numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare g public.gonderimler; v_eski numeric;
begin
  perform public._yetki_yonetim();
  perform public._fiyat_dogrula(p_fiyat);
  select * into g from public.gonderimler where id = p_gonderim_id;
  if not found then raise exception 'Gönderim kaydı bulunamadı. Silinmiş olabilir.'; end if;
  perform 1 from public.kaliplar where id = g.kalip_id for update;
  select fiyat into v_eski from public.gonderim_fiyatlari where gonderim_id = p_gonderim_id for update;
  if v_eski is not distinct from p_fiyat then return; end if;
  if p_fiyat is null then
    delete from public.gonderim_fiyatlari where gonderim_id = p_gonderim_id;
  else
    insert into public.gonderim_fiyatlari (gonderim_id, fiyat, guncelleyen_id, guncelleyen_ad, guncelleme)
    values (p_gonderim_id, p_fiyat, auth.uid(), public.ben_ad(), now())
    on conflict (gonderim_id) do update
      set fiyat = excluded.fiyat, guncelleyen_id = excluded.guncelleyen_id,
          guncelleyen_ad = excluded.guncelleyen_ad, guncelleme = excluded.guncelleme;
  end if;
  perform public._kayit('gonderim_fiyatlari', p_gonderim_id, 'fiyat',
    jsonb_build_object('fiyat', v_eski), jsonb_build_object('fiyat', p_fiyat));
end $$;

revoke all on function public._fiyat_dogrula(numeric) from public, anon;
grant execute on function public._fiyat_dogrula(numeric) to authenticated;
revoke all on function public.kalip_gonder(uuid, uuid, text, numeric) from public, anon;
grant execute on function public.kalip_gonder(uuid, uuid, text, numeric) to authenticated;
revoke all on function public.gonderim_fiyat_ayarla(uuid, numeric) from public, anon;
grant execute on function public.gonderim_fiyat_ayarla(uuid, numeric) to authenticated;
