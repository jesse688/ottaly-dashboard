-- Apollo Contacts Database Schema
-- PostgreSQL 15+
-- Optimized for millions of contacts with efficient indexing

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For text search

-- ── Main Contacts Table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id TEXT NOT NULL,

  -- Basic Contact Info
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,

  -- Company Info
  company_name TEXT,
  company_domain TEXT,
  job_title TEXT,
  job_title_cleaned TEXT, -- Normalized title
  seniority TEXT, -- junior, manager, director, vp, c_suite
  department TEXT,

  -- Location — Person
  city TEXT,
  state TEXT,
  country TEXT,
  person_region TEXT,
  person_county TEXT,
  person_town TEXT,

  -- Location — Company
  company_address TEXT,
  company_city TEXT,
  company_state TEXT,
  company_country TEXT,
  -- Normalised hierarchy: Country > Region > County > City > Town
  company_region TEXT,
  company_county TEXT,
  company_town TEXT,
  location_source TEXT,                 -- postcode|place|county|country|website|manual
  location_needs_review BOOLEAN DEFAULT false,
  location_review_reason TEXT,
  location_normalized_at TIMESTAMPTZ,

  -- Additional fields
  linkedin_url TEXT,
  company_linkedin_url TEXT,
  industry TEXT,
  num_employees INT,
  keywords TEXT,
  technologies TEXT,
  corporate_phone TEXT,
  company_phone TEXT,
  sub_departments TEXT,
  email_verified_at TEXT,

  -- Apollo-specific Fields
  apollo_id TEXT,
  apollo_person_id TEXT,

  -- Contact Engagement
  status TEXT DEFAULT 'new', -- new, active, interested, replied, not_interested, bounced
  last_engaged_at TIMESTAMP,
  emails_sent INT DEFAULT 0,
  emails_opened INT DEFAULT 0,
  emails_clicked INT DEFAULT 0,
  replies_count INT DEFAULT 0,

  -- Metadata
  source TEXT, -- 'apollo_csv', 'manual', 'api', etc
  raw_data JSONB, -- Full Apollo record for flexibility
  tags TEXT[], -- Array of tags for grouping

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  imported_at TIMESTAMP,

  -- Constraints
  UNIQUE(workspace_id, email)
);

-- Partial unique index for apollo_person_id (only when not null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_apollo_person_id
ON contacts(workspace_id, apollo_person_id) WHERE apollo_person_id IS NOT NULL;

-- ── Campaigns Table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'draft', -- draft, active, paused, completed
  contact_count INT DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(workspace_id, name)
);

-- ── Campaign Contacts Junction ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_contacts (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending', -- pending, sent, opened, clicked, replied
  sent_at TIMESTAMP,
  opened_at TIMESTAMP,
  clicked_at TIMESTAMP,
  replied_at TIMESTAMP,

  PRIMARY KEY (campaign_id, contact_id)
);

-- ── CSV Import Batches (for tracking bulk imports) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  total_rows INT NOT NULL,
  imported_rows INT DEFAULT 0,
  duplicate_rows INT DEFAULT 0,
  error_rows INT DEFAULT 0,
  status TEXT DEFAULT 'processing', -- processing, completed, failed
  error_message TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

-- ── Indexing (Critical for performance with millions of records) ──────────────────────────────────────

-- Search indexes
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_email ON contacts(workspace_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_domain);
CREATE INDEX IF NOT EXISTS idx_contacts_job_title ON contacts(job_title_cleaned);
CREATE INDEX IF NOT EXISTS idx_contacts_seniority ON contacts(seniority);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);

-- Workspace queries
CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_status ON contacts(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_created ON contacts(workspace_id, created_at DESC);

-- Full-text search (GIN index for JSONB)
CREATE INDEX IF NOT EXISTS idx_contacts_raw_data_gin ON contacts USING GIN(raw_data);

-- Apollo ID lookup
CREATE INDEX IF NOT EXISTS idx_contacts_apollo_id ON contacts(apollo_id);

-- Campaign indexes
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_contact ON campaign_contacts(contact_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status ON campaign_contacts(status);

-- Import tracking
CREATE INDEX IF NOT EXISTS idx_import_batches_workspace ON import_batches(workspace_id);

-- ── Partitioning (for very large datasets, can be added later) ──────────────────────────────────────
-- Partition contacts by workspace for even better performance
-- CREATE TABLE contacts_ottaly PARTITION OF contacts FOR VALUES IN ('690ee665bcb253de4fb44538');

-- ── Triggers ──────────────────────────────────────────────────────────────
-- The contacts_update_timestamp trigger lives in db-postgres.js init() now;
-- the splitter we use to apply this file chops on every ";<eol>", which
-- shreds dollar-quoted PL/pgSQL bodies. Keeping it out of here avoids that.

-- ── Views ──────────────────────────────────────────────────────────────
-- Workspace contact summary
CREATE OR REPLACE VIEW contacts_summary AS
SELECT
  workspace_id,
  COUNT(*) as total_contacts,
  COUNT(CASE WHEN status = 'new' THEN 1 END) as new_contacts,
  COUNT(CASE WHEN status = 'interested' THEN 1 END) as interested,
  COUNT(CASE WHEN status = 'replied' THEN 1 END) as replied,
  COUNT(CASE WHEN status = 'bounced' THEN 1 END) as bounced,
  COUNT(DISTINCT company_domain) as unique_companies
FROM contacts
GROUP BY workspace_id;
