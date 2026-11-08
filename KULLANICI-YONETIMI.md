# Kullanıcı yönetimi (Supabase)

Kullanıcılar ve şifreler `index.html` içinde değil, Supabase'te durur.
Dışarıdan kayıt kapalıdır; kullanıcıları yalnızca siz eklersiniz.

- Panel: https://supabase.com/dashboard/project/puzixopquysefichmkfh
- Kullanıcı adı `ahmet` olan kişi Supabase'te `ahmet@tumersan.local` olarak tutulur.
  Bu adrese hiçbir zaman e-posta gönderilmez.
- Kullanıcı adında Türkçe harf ve büyük harf **kullanmayın** (`ahmet`, `ayse`, `uretim2` gibi).
  Giriş ekranında kişi "Ayşe" ya da "AYSE" yazsa da `ayse` olarak tanınır.

## 1. Yeni kullanıcı ekleme (2 adım)

**Adım 1 - Kullanıcıyı oluştur:**
Panel → **Authentication** → **Users** → **Add user** → **Create new user**
- Email: `ahmet@tumersan.local`
- Password: belirlediğiniz şifre (en az 6 karakter)
- **Auto Confirm User** kutusu işaretli olsun
- **Create user**

**Adım 2 - Bölümünü ve görünen adını ver:**
Panel → **SQL Editor** → **New query** → aşağıdakini yapıştırın, kırmızı yerleri değiştirip **Run**:

```sql
update auth.users
set raw_app_meta_data  = raw_app_meta_data  || '{"bolumler": ["uretim"]}',
    raw_user_meta_data = raw_user_meta_data || '{"gorunen_ad": "Ahmet Yılmaz"}'
where email = 'ahmet@tumersan.local';
```

`bolumler` kişinin girebileceği bölümlerin listesidir:
- Yalnızca Üretim: `["uretim"]`
- Yalnızca Yönetim: `["yonetim"]`
- İkisi birden: `["yonetim", "uretim"]`

Bölümü atanmamış kullanıcı giriş yapamaz.

> **Kısa şifre:** Supabase paneli "Add user" ekranında en az 6 karakter ister.
> Daha kısa bir şifre isterseniz önce 6+ karakterli geçici bir şifreyle oluşturun,
> sonra 2. maddedeki komutla kısa şifreyi verin.

## 2. Şifre değiştirme

SQL Editor'de:

```sql
update auth.users
set encrypted_password = crypt('YeniSifre123', gen_salt('bf'))
where email = 'ahmet@tumersan.local';
```

## 3. Bölüm veya görünen adı değiştirme

1. madde, 2. adımdaki komutu yeni değerlerle tekrar çalıştırın.
Kişi bir sonraki girişinde yeni bölümüyle girer.

## 4. Kullanıcıyı silme

Panel → **Authentication** → **Users** → kullanıcının satırındaki **⋯** → **Delete user**.
O kişi uygulamayı bir sonraki açışında giriş ekranına düşer.

## 5. Tüm kullanıcıları listeleme

```sql
select split_part(email, '@', 1)            as kullanici_adi,
       raw_app_meta_data  ->  'bolumler'     as bolumler,
       raw_user_meta_data ->> 'gorunen_ad'   as gorunen_ad,
       last_sign_in_at                       as son_giris
from auth.users
order by email;
```

## Kalıp takibinde yetkiler

Yetkiler hem ekranda hem Supabase veritabanında ve fotoğraf deposunda uygulanır.

| İşlem | Yönetim | Üretim |
|---|---|---|
| Aktif kalıpları, fotoğrafları ve geçmişi görme | ✓ | ✓ |
| Tedarikçiye gönderme / rafa geri alma (açıklama, adet) | ✓ | ✓ |
| Gönderim fiyatını görme, girme, düzenleme | ✓ | – (veritabanı Üretime fiyat hiç döndürmez) |
| Excel'e aktarma | ✓ | – |
| Kalıp oluşturma, düzenleme, fotoğraf | ✓ | – |
| Tedarikçi ekleme, ad düzeltme, silme | ✓ | – |
| Geçmiş kayıtları düzeltme | ✓ | – |
| Arşiv: görme, arşive alma, geri getirme, kalıcı silme | ✓ | – |
| Excel'e arşivi de dahil etme | ✓ | – |

Not: Ekran, girişte seçilen düğmeye göre açılır. Veritabanı ise kişinin `bolumler`
listesine bakar. `ym` gibi iki bölüme yetkili biri Üretim düğmesiyle girse de
veritabanında Yönetim yetkisi vardır, yalnızca ekranda Yönetim düğmeleri görünmez.

Veritabanı kurulumunun tamamı: `supabase/migrations/` klasöründeki dosyalar (tarih sırasıyla).
Fiyatlar ayrı `gonderim_fiyatlari` tablosunda durur; bu tabloyu yalnızca Yönetim okuyabilir.

## Şu anki kullanıcılar

| Kullanıcı adı | Girebildiği bölümler | Görünen ad |
|---|---|---|
| `ym` | Yönetim, Üretim | Muammer Tüm |
| `uretim` | Üretim | Üretim |

Şifreler bu dosyada yazmaz (depo herkese açık).
