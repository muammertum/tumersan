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
set raw_app_meta_data  = raw_app_meta_data  || '{"bolum": "uretim"}',
    raw_user_meta_data = raw_user_meta_data || '{"gorunen_ad": "Ahmet Yılmaz"}'
where email = 'ahmet@tumersan.local';
```

`bolum` yalnızca `"yonetim"` ya da `"uretim"` olabilir.
Bölümü atanmamış kullanıcı giriş yapamaz.

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
       raw_app_meta_data  ->> 'bolum'        as bolum,
       raw_user_meta_data ->> 'gorunen_ad'   as gorunen_ad,
       last_sign_in_at                       as son_giris
from auth.users
order by email;
```

## Şu anki deneme kullanıcıları

| Kullanıcı adı | Bölüm | Görünen ad |
|---|---|---|
| `muammer` | yonetim | Muammer Tüm |
| `uretim` | uretim | Üretim |

Şifreleri, ilk sürümde dosyada duran deneme şifreleriyle aynıdır.
Gerçek kullanıma geçmeden önce 2. maddedeki komutla değiştirin.
