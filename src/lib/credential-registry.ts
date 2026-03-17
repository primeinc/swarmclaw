/**
 * Credential registry: static templates for common services.
 * Agents use these to know what credentials a service needs,
 * where to get them, and how to validate them.
 *
 * Isomorphic — no server imports.
 */

export interface CredentialField {
  key: string
  label: string
  description?: string
  required?: boolean
  /** If true, the value is a secret (token, password) */
  secret?: boolean
  placeholder?: string
}

export interface CredentialTemplate {
  serviceId: string
  name: string
  category: 'hosting' | 'database' | 'payment' | 'email' | 'scheduling' | 'communication' | 'storage' | 'analytics' | 'auth' | 'other'
  fields: CredentialField[]
  signupUrl?: string
  keyUrl?: string
  keyLabel?: string
  notes?: string
  /** Whether a free tier is available via browser signup */
  canSelfProvision?: boolean
  /** URL for a quick health-check (e.g. GET with Bearer token returns 2xx) */
  validationEndpoint?: string
  validationMethod?: 'header_auth' | 'query_auth' | 'basic_auth'
}

const TOKEN_FIELD: CredentialField = { key: 'token', label: 'API Token', secret: true, required: true }
const API_KEY_FIELD: CredentialField = { key: 'api_key', label: 'API Key', secret: true, required: true }

export const CREDENTIAL_TEMPLATES: CredentialTemplate[] = [
  // ── Hosting ──
  {
    serviceId: 'netlify',
    name: 'Netlify',
    category: 'hosting',
    fields: [{ ...TOKEN_FIELD, label: 'Personal Access Token', placeholder: 'nfp_...' }],
    signupUrl: 'https://app.netlify.com/signup',
    keyUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    keyLabel: 'app.netlify.com',
    canSelfProvision: true,
    validationEndpoint: 'https://api.netlify.com/api/v1/user',
    validationMethod: 'header_auth',
    notes: 'Free tier includes 100 GB bandwidth/month, 300 build minutes/month.',
  },
  {
    serviceId: 'vercel',
    name: 'Vercel',
    category: 'hosting',
    fields: [{ ...TOKEN_FIELD, label: 'Vercel Token', placeholder: 'vercel_...' }],
    signupUrl: 'https://vercel.com/signup',
    keyUrl: 'https://vercel.com/account/tokens',
    keyLabel: 'vercel.com',
    canSelfProvision: true,
    validationEndpoint: 'https://api.vercel.com/v2/user',
    validationMethod: 'header_auth',
    notes: 'Free Hobby tier available. Token needs appropriate scopes for deployment.',
  },
  {
    serviceId: 'surge',
    name: 'Surge.sh',
    category: 'hosting',
    fields: [{ ...TOKEN_FIELD, label: 'Surge Token', placeholder: 'surge_token_...' }],
    signupUrl: 'https://surge.sh',
    keyUrl: 'https://surge.sh/help/integrating-with-circleci',
    keyLabel: 'surge.sh',
    canSelfProvision: true,
    notes: 'Run `surge token` in a terminal after `npm install -g surge && surge login` to get the token.',
  },
  {
    serviceId: 'render',
    name: 'Render',
    category: 'hosting',
    fields: [{ ...API_KEY_FIELD, label: 'Render API Key', placeholder: 'rnd_...' }],
    signupUrl: 'https://dashboard.render.com/register',
    keyUrl: 'https://dashboard.render.com/u/settings#api-keys',
    keyLabel: 'dashboard.render.com',
    canSelfProvision: true,
    validationEndpoint: 'https://api.render.com/v1/owners',
    validationMethod: 'header_auth',
  },
  {
    serviceId: 'fly',
    name: 'Fly.io',
    category: 'hosting',
    fields: [{ ...TOKEN_FIELD, label: 'Fly.io API Token' }],
    signupUrl: 'https://fly.io/app/sign-up',
    keyUrl: 'https://fly.io/user/personal_access_tokens',
    keyLabel: 'fly.io',
    canSelfProvision: true,
  },

  // ── Database ──
  {
    serviceId: 'supabase',
    name: 'Supabase',
    category: 'database',
    fields: [
      { key: 'url', label: 'Project URL', required: true, placeholder: 'https://xxxx.supabase.co' },
      { key: 'anon_key', label: 'Anon/Public Key', secret: true, required: true, placeholder: 'eyJ...' },
      { key: 'service_role_key', label: 'Service Role Key', secret: true, placeholder: 'eyJ...' },
    ],
    signupUrl: 'https://supabase.com/dashboard',
    keyUrl: 'https://supabase.com/dashboard/project/_/settings/api',
    keyLabel: 'supabase.com',
    canSelfProvision: true,
    notes: 'Free tier: 500 MB database, 1 GB file storage, 50K monthly active users.',
  },
  {
    serviceId: 'planetscale',
    name: 'PlanetScale',
    category: 'database',
    fields: [
      { key: 'connection_string', label: 'Connection String', secret: true, required: true, placeholder: 'mysql://...' },
    ],
    signupUrl: 'https://auth.planetscale.com/sign-up',
    keyUrl: 'https://app.planetscale.com',
    keyLabel: 'app.planetscale.com',
    canSelfProvision: true,
  },
  {
    serviceId: 'neon',
    name: 'Neon',
    category: 'database',
    fields: [
      { key: 'connection_string', label: 'Connection String', secret: true, required: true, placeholder: 'postgresql://...' },
      { key: 'api_key', label: 'Neon API Key', secret: true, placeholder: 'neon_...' },
    ],
    signupUrl: 'https://console.neon.tech/signup',
    keyUrl: 'https://console.neon.tech/app/settings/api-keys',
    keyLabel: 'console.neon.tech',
    canSelfProvision: true,
  },

  // ── Payment ──
  {
    serviceId: 'stripe',
    name: 'Stripe',
    category: 'payment',
    fields: [
      { key: 'secret_key', label: 'Secret Key', secret: true, required: true, placeholder: 'sk_test_...' },
      { key: 'publishable_key', label: 'Publishable Key', placeholder: 'pk_test_...' },
    ],
    signupUrl: 'https://dashboard.stripe.com/register',
    keyUrl: 'https://dashboard.stripe.com/apikeys',
    keyLabel: 'dashboard.stripe.com',
    canSelfProvision: true,
    validationEndpoint: 'https://api.stripe.com/v1/balance',
    validationMethod: 'basic_auth',
    notes: 'Use test keys (sk_test_) for development. Switch to live keys for production.',
  },

  // ── Email ──
  {
    serviceId: 'sendgrid',
    name: 'SendGrid',
    category: 'email',
    fields: [{ ...API_KEY_FIELD, label: 'SendGrid API Key', placeholder: 'SG...' }],
    signupUrl: 'https://signup.sendgrid.com/',
    keyUrl: 'https://app.sendgrid.com/settings/api_keys',
    keyLabel: 'app.sendgrid.com',
    canSelfProvision: true,
    validationEndpoint: 'https://api.sendgrid.com/v3/user/profile',
    validationMethod: 'header_auth',
    notes: 'Free tier: 100 emails/day.',
  },
  {
    serviceId: 'resend',
    name: 'Resend',
    category: 'email',
    fields: [{ ...API_KEY_FIELD, label: 'Resend API Key', placeholder: 're_...' }],
    signupUrl: 'https://resend.com/signup',
    keyUrl: 'https://resend.com/api-keys',
    keyLabel: 'resend.com',
    canSelfProvision: true,
    validationEndpoint: 'https://api.resend.com/domains',
    validationMethod: 'header_auth',
    notes: 'Free tier: 100 emails/day, 3,000/month.',
  },
  {
    serviceId: 'mailgun',
    name: 'Mailgun',
    category: 'email',
    fields: [
      { ...API_KEY_FIELD, label: 'Mailgun API Key', placeholder: 'key-...' },
      { key: 'domain', label: 'Sending Domain', required: true, placeholder: 'mg.example.com' },
    ],
    signupUrl: 'https://signup.mailgun.com/new/signup',
    keyUrl: 'https://app.mailgun.com/settings/api_security',
    keyLabel: 'app.mailgun.com',
    canSelfProvision: true,
  },

  // ── Scheduling ──
  {
    serviceId: 'calendly',
    name: 'Calendly',
    category: 'scheduling',
    fields: [{ ...TOKEN_FIELD, label: 'Personal Access Token' }],
    signupUrl: 'https://calendly.com/signup',
    keyUrl: 'https://calendly.com/integrations/api_webhooks',
    keyLabel: 'calendly.com',
    canSelfProvision: true,
    validationEndpoint: 'https://api.calendly.com/users/me',
    validationMethod: 'header_auth',
  },

  // ── Communication ──
  {
    serviceId: 'twilio',
    name: 'Twilio',
    category: 'communication',
    fields: [
      { key: 'account_sid', label: 'Account SID', required: true, placeholder: 'AC...' },
      { key: 'auth_token', label: 'Auth Token', secret: true, required: true },
    ],
    signupUrl: 'https://www.twilio.com/try-twilio',
    keyUrl: 'https://console.twilio.com/',
    keyLabel: 'console.twilio.com',
    canSelfProvision: true,
    notes: 'Free trial includes $15 credit.',
  },

  // ── Storage ──
  {
    serviceId: 'aws_s3',
    name: 'AWS S3',
    category: 'storage',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', required: true, placeholder: 'AKIA...' },
      { key: 'secret_access_key', label: 'Secret Access Key', secret: true, required: true },
      { key: 'region', label: 'Region', placeholder: 'us-east-1' },
      { key: 'bucket', label: 'Bucket Name', placeholder: 'my-bucket' },
    ],
    signupUrl: 'https://portal.aws.amazon.com/billing/signup',
    keyUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    keyLabel: 'console.aws.amazon.com',
    notes: 'Free tier: 5 GB standard storage, 20K GET, 2K PUT requests/month for 12 months.',
  },
  {
    serviceId: 'cloudflare_r2',
    name: 'Cloudflare R2',
    category: 'storage',
    fields: [
      { key: 'account_id', label: 'Account ID', required: true },
      { key: 'access_key_id', label: 'Access Key ID', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', secret: true, required: true },
    ],
    signupUrl: 'https://dash.cloudflare.com/sign-up',
    keyUrl: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
    keyLabel: 'dash.cloudflare.com',
    canSelfProvision: true,
    notes: 'Free tier: 10 GB storage, 10M reads, 1M writes/month. No egress fees.',
  },

  // ── Auth ──
  {
    serviceId: 'clerk',
    name: 'Clerk',
    category: 'auth',
    fields: [
      { key: 'secret_key', label: 'Secret Key', secret: true, required: true, placeholder: 'sk_test_...' },
      { key: 'publishable_key', label: 'Publishable Key', placeholder: 'pk_test_...' },
    ],
    signupUrl: 'https://dashboard.clerk.com/sign-up',
    keyUrl: 'https://dashboard.clerk.com',
    keyLabel: 'dashboard.clerk.com',
    canSelfProvision: true,
  },
  {
    serviceId: 'auth0',
    name: 'Auth0',
    category: 'auth',
    fields: [
      { key: 'domain', label: 'Domain', required: true, placeholder: 'your-tenant.auth0.com' },
      { key: 'client_id', label: 'Client ID', required: true },
      { key: 'client_secret', label: 'Client Secret', secret: true, required: true },
    ],
    signupUrl: 'https://auth0.com/signup',
    keyUrl: 'https://manage.auth0.com/#/applications',
    keyLabel: 'manage.auth0.com',
    canSelfProvision: true,
  },

  // ── Analytics ──
  {
    serviceId: 'posthog',
    name: 'PostHog',
    category: 'analytics',
    fields: [
      { key: 'api_key', label: 'Project API Key', required: true, placeholder: 'phc_...' },
      { key: 'host', label: 'Host', placeholder: 'https://app.posthog.com' },
    ],
    signupUrl: 'https://app.posthog.com/signup',
    keyUrl: 'https://app.posthog.com/project/settings',
    keyLabel: 'app.posthog.com',
    canSelfProvision: true,
  },
]

const templateIndex = new Map<string, CredentialTemplate>()
for (const t of CREDENTIAL_TEMPLATES) templateIndex.set(t.serviceId, t)

/** Look up a credential template by service ID (case-insensitive, trimmed). */
export function getCredentialTemplate(serviceId: string): CredentialTemplate | null {
  const normalized = serviceId.trim().toLowerCase()
  return templateIndex.get(normalized) || null
}

/** Fuzzy-match a service name against known templates. */
export function findCredentialTemplate(query: string): CredentialTemplate | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  // Exact serviceId match
  const exact = templateIndex.get(q)
  if (exact) return exact
  // Name match (case-insensitive)
  const byName = CREDENTIAL_TEMPLATES.find((t) => t.name.toLowerCase() === q)
  if (byName) return byName
  // Substring match on name or serviceId
  const partial = CREDENTIAL_TEMPLATES.find(
    (t) => t.name.toLowerCase().includes(q) || t.serviceId.includes(q),
  )
  return partial || null
}

/** List all templates in a given category. */
export function listCredentialTemplatesByCategory(category: CredentialTemplate['category']): CredentialTemplate[] {
  return CREDENTIAL_TEMPLATES.filter((t) => t.category === category)
}

/**
 * Build a human-readable credential request message for ask_human.
 * Used by the `request` action in manage_secrets.
 */
export function buildCredentialRequestMessage(template: CredentialTemplate, reason: string): string {
  const lines: string[] = []
  lines.push(`**Credential needed: ${template.name}**`)
  lines.push('')
  if (reason) lines.push(`Reason: ${reason}`)
  lines.push('')
  lines.push('Required fields:')
  for (const field of template.fields) {
    if (field.required !== false) {
      const desc = field.description ? ` — ${field.description}` : ''
      const placeholder = field.placeholder ? ` (e.g. \`${field.placeholder}\`)` : ''
      lines.push(`- **${field.label}**${desc}${placeholder}`)
    }
  }
  if (template.keyUrl) {
    lines.push('')
    lines.push(`Get your key here: ${template.keyUrl}`)
  }
  if (template.signupUrl) {
    lines.push(`Sign up: ${template.signupUrl}`)
  }
  if (template.notes) {
    lines.push('')
    lines.push(`Note: ${template.notes}`)
  }
  return lines.join('\n')
}
