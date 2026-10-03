-- Промокоды
CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  tries INT NOT NULL DEFAULT 2,
  unlimited BOOLEAN NOT NULL DEFAULT FALSE,
  max_uses INT NOT NULL DEFAULT 100,
  used_count INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS promo_uses (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL,
  tg_id BIGINT NOT NULL,
  used_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(code, tg_id)
);

CREATE INDEX IF NOT EXISTS promo_uses_user_idx ON promo_uses (tg_id);

-- Админы и модерация
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS products_pinned_idx ON products (is_pinned);

-- Сделать вас админами
UPDATE users SET is_admin = TRUE WHERE tg_id IN (1068105255, 1262692839);
