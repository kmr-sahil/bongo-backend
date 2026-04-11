-- ============================================================
-- Migration 001: Initial Schema
-- Bengali Ecommerce Platform — PostgreSQL
-- ============================================================

-- Required for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Enums
-- ============================================================

DO $$ BEGIN
CREATE TYPE user_role AS ENUM ('user', 'admin');
EXCEPTION
WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
CREATE TYPE order_status AS ENUM (
  'pending', 'confirmed', 'processing',
  'shipped', 'out_for_delivery', 'delivered',
  'cancelled', 'returned'
);
EXCEPTION
WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');
EXCEPTION
WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
CREATE TYPE payment_method AS ENUM ('cod', 'upi', 'card', 'netbanking', 'wallet');
EXCEPTION
WHEN duplicate_object THEN null;
END $$;

-- ============================================================
-- Users
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'user',
  otp VARCHAR(10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================
-- Addresses
-- ============================================================

CREATE TABLE IF NOT EXISTS addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  country VARCHAR(100) NOT NULL DEFAULT 'India',
  pincode VARCHAR(10) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);

-- ============================================================
-- Categories
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);

-- ============================================================
-- Products
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(500) NOT NULL,
  slug VARCHAR(500) NOT NULL UNIQUE,
  description TEXT NOT NULL,
  category_id UUID NOT NULL REFERENCES categories(id),
  price NUMERIC(10,2) NOT NULL,
  sale_price NUMERIC(10,2),
  sku VARCHAR(100) UNIQUE,
  stock INT NOT NULL DEFAULT 0,
  weight VARCHAR(50),
  size_or_dimensions VARCHAR(255),
  keywords TEXT[] DEFAULT '{}',
  is_bestseller BOOLEAN NOT NULL DEFAULT FALSE,
  is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  stock_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at);

-- ============================================================
-- Product Images
-- ============================================================

CREATE TABLE IF NOT EXISTS product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  alt_text VARCHAR(500),
  sort_order INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images(product_id);

-- ============================================================
-- Wishlists
-- ============================================================

CREATE TABLE IF NOT EXISTS wishlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wishlists_user_id ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_product_id ON wishlists(product_id);

-- ============================================================
-- Orders
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  status order_status NOT NULL DEFAULT 'pending',
  total_amount NUMERIC(10,2) NOT NULL,
  payment_status payment_status NOT NULL DEFAULT 'pending',
  payment_method payment_method NOT NULL DEFAULT 'cod',
  address_id UUID NOT NULL REFERENCES addresses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- ============================================================
-- Order Items
-- ============================================================

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INT NOT NULL,
  price_snapshot NUMERIC(10,2) NOT NULL,
  product_name_snapshot VARCHAR(500) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- ============================================================
-- Blogs
-- ============================================================

CREATE TABLE IF NOT EXISTS blogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500) NOT NULL UNIQUE,
  content TEXT NOT NULL,
  featured_image TEXT,
  meta_title VARCHAR(255),
  meta_description VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blogs_slug ON blogs(slug);
CREATE INDEX IF NOT EXISTS idx_blogs_created_at ON blogs(created_at);

-- ============================================================
-- Product Views
-- ============================================================

CREATE TABLE IF NOT EXISTS product_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_views_product_id ON product_views(product_id);
CREATE INDEX IF NOT EXISTS idx_product_views_user_id ON product_views(user_id);
CREATE INDEX IF NOT EXISTS idx_product_views_viewed_at ON product_views(viewed_at);

-- ============================================================
-- Delivery Zones
-- ============================================================

CREATE TABLE IF NOT EXISTS delivery_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pincode VARCHAR(10) NOT NULL UNIQUE,
  delivery_available BOOLEAN NOT NULL DEFAULT TRUE,
  delivery_time_days INT NOT NULL DEFAULT 5
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_pincode ON delivery_zones(pincode);

-- ============================================================
-- Updated_at Trigger
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_blogs_updated_at ON blogs;
CREATE TRIGGER update_blogs_updated_at
BEFORE UPDATE ON blogs
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Migration 002: Seed Categories
-- ============================================================

INSERT INTO categories (name, slug) VALUES
  ('Books & Magazines',              'books-magazines'),
  ('Children''s Books – Early Learning', 'childrens-books-early-learning'),
  ('Clothing – Traditional Wear',    'clothing-traditional-wear'),
  ('Fruits & Vegetables',            'fruits-vegetables'),
  ('Groceries',                      'groceries'),
  ('Herbs & Spices',                 'herbs-spices'),
  ('Kitchen & Dining Utilities',     'kitchen-dining-utilities'),
  ('Kolkata Special Seasonal Items', 'kolkata-special-seasonal-items'),
  ('Lentils / Dal & Rice',           'lentils-dal-rice'),
  ('Oil & Ghee',                     'oil-ghee'),
  ('Puja Samogri',                   'puja-samogri'),
  ('Skin Care',                      'skin-care'),
  ('Snacks & Homemade Pickles',      'snacks-homemade-pickles'),
  ('Tea & Infusions',                'tea-infusions'),
  ('Uncategorized',                  'uncategorized');


-- Notify me

CREATE TABLE product_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  notified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);

CREATE TABLE newsletters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  email VARCHAR(255) NOT NULL UNIQUE,

  is_subscribed BOOLEAN NOT NULL DEFAULT TRUE,

  subscribed_at TIMESTAMPTZ DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INT NOT NULL,
  original_price NUMERIC(10,2) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cart_user_id ON cart(user_id);
CREATE INDEX IF NOT EXISTS idx_cart_updated_at ON cart(updated_at);

CREATE TABLE IF NOT EXISTS cart_abandon_reminders (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_cart_activity_at TIMESTAMPTZ NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cart_abandon_reminders_last_sent_at ON cart_abandon_reminders(last_sent_at);

DROP TRIGGER IF EXISTS update_cart_abandon_reminders_updated_at ON cart_abandon_reminders;
CREATE TRIGGER update_cart_abandon_reminders_updated_at
BEFORE UPDATE ON cart_abandon_reminders
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


CREATE TABLE IF NOT EXISTS available_payment_method(
  id SERIAL PRIMARY KEY,
  payment_method VARCHAR(50) NOT NULL UNIQUE,
  is_available BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default payment methods
INSERT INTO available_payment_method (payment_method, is_available, notes) VALUES
  ('cash_on_delivery', true, 'Pay when you receive your order'),
  ('phonepe', true, 'Continue With Phone Pay for UPI, Net Banking & Credit/Debit Card')
ON CONFLICT (payment_method) DO NOTHING;

CREATE TABLE IF NOT EXISTS shiprocket_key(
  id INT PRIMARY KEY DEFAULT 1,
  shiprocket_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row_only CHECK (id = 1)
);

DROP TRIGGER IF EXISTS update_shiprocket_key_updated_at ON shiprocket_key;
CREATE TRIGGER update_shiprocket_key_updated_at
BEFORE UPDATE ON shiprocket_key
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();