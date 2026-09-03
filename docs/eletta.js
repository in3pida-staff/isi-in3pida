/**
 * eletta.js — Script embeddabile Eletta
 * Uso: <script src="https://app.eletta-ai.it/eletta.js?id=SITE_ID" async></script>
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://yyauvoqjdzrbmebeafit.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl5YXV2b3FqZHpyYm1lYmVhZml0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3OTM2MDAsImV4cCI6MjA5NTM2OTYwMH0.M6kD56PEO_UcJ68Vjquo03vuORjv62MflIzGLzYKN9w';
  const HEARTBEAT_INTERVAL = 30 * 60 * 1000;
  const AI_PROFILE_URL = SUPABASE_URL + '/functions/v1/ai-profile';

  function getSiteId() {
    try {
      const scripts = document.querySelectorAll('script[src*="eletta.js"]');
      for (const s of scripts) {
        const u = new URL(s.src);
        const id = u.searchParams.get('id');
        if (id) return id;
      }
    } catch (_) {}
    return null;
  }

  async function fetchSite(siteId) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${encodeURIComponent(siteId)}&select=site_id,site_name,site_url,hotel_profile,schema_data,faq_data,plugin_version`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] || null;
  }

  function computeGeoScores(site) {
    const sd = site.schema_data || {};
    const hp = site.hotel_profile || {};
    const faqItems = ((site.faq_data || {}).items || [])
      .filter(function(i) { return i.status === 'publish' || i.status === 'published' || (!i.status && i.solo_ai !== true); });

    var checks = [
      sd.name || hp.nome_hotel,
      sd.description || hp.descrizione,
      sd.telephone || hp.telefono,
      sd.email || hp.email,
      sd.city || hp.citta,
      sd.street || hp.via,
      sd.official_rating || hp.stelle,
      sd.checkin_time || hp.checkin_dalle,
      sd.checkout_time || hp.checkout_dalle,
      sd.latitude || hp.latitudine,
    ];
    var filled = checks.filter(Boolean).length;
    var completeness_score = Math.round(filled / checks.length * 100);
    var coverage_pct = faqItems.length >= 10 ? 100 : faqItems.length >= 5 ? 75 : faqItems.length >= 1 ? 40 : 0;
    var has_ai_profile = hp.ai_layer_disabled !== true;
    var ai_readiness = Math.round(completeness_score * 0.5 + coverage_pct * 0.3 + (has_ai_profile ? 20 : 0));

    return { completeness_score: completeness_score, coverage_pct: coverage_pct, has_ai_profile: has_ai_profile, ai_readiness: ai_readiness };
  }

  function detectGscSignals() {
    var s = {};
    // google-site-verification meta tag
    if (document.querySelector('meta[name="google-site-verification"]')) s.gsc_verified = true;
    // Google Site Kit
    if (document.querySelector('[id*="googlesitekit"]') ||
        document.querySelector('script[src*="googlesitekit"]') ||
        window.googlesitekit) s.site_kit = true;
    // Yoast SEO
    if (document.querySelector('meta[name="generator"][content*="Yoast"]') ||
        document.querySelector('#yoast-schema-graph') ||
        document.querySelector('#yoast-schema-graph-tag')) s.yoast = true;
    // RankMath
    if (document.querySelector('meta[name="generator"][content*="Rank Math"]') ||
        document.querySelector('#rank-math-schema')) s.rank_math = true;
    // SEOPress
    if (document.querySelector('script[src*="seopress"]')) s.seopress = true;
    // Google Tag Manager
    if (document.querySelector('script[src*="googletagmanager.com/gtm"]') ||
        window.google_tag_manager) s.gtm = true;
    // Google Analytics (GA4 / Universal)
    if (document.querySelector('script[src*="googletagmanager.com/gtag"]') ||
        document.querySelector('script[src*="google-analytics.com"]') ||
        typeof window.gtag === 'function' || typeof window.ga === 'function') s.ga = true;
    // Google Ads
    if (document.querySelector('script[src*="googleadservices.com"]')) s.google_ads = true;
    return Object.keys(s).length ? s : null;
  }

  async function sendHeartbeat(siteId, siteName, site) {
    var now = new Date().toISOString();
    var scores = site ? computeGeoScores(site) : null;
    var patch = { last_heartbeat: now, site_url: location.origin };
    if (scores) patch.geo_scores = scores;
    var gscSignals = detectGscSignals();
    if (gscSignals) patch.gsc_signals = gscSignals;
    await fetch(`${SUPABASE_URL}/rest/v1/isi_sites?site_id=eq.${encodeURIComponent(siteId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${SUPABASE_ANON}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    }).catch(function() {});
  }

  function injectAiLayerLink(siteId) {
    if (document.querySelector('link[data-eletta-ai]')) return;
    const link = document.createElement('link');
    link.rel = 'alternate';
    link.type = 'application/ld+json';
    link.href = AI_PROFILE_URL + '?site_id=' + encodeURIComponent(siteId);
    link.setAttribute('data-eletta-ai', '1');
    document.head.appendChild(link);
  }

  function injectSchema(site) {
    const sd = site.schema_data || {};
    // Inietta lo Schema.org SOLO se la configurazione è completa (nome + descrizione + indirizzo + città + telefono).
    // Evita snippet incompleti che generano avvisi in Google Search Console / lamentele delle agenzie SEO.
    var schemaComplete = !!(sd.name && sd.description && sd.street && sd.city && sd.telephone);
    if (!schemaComplete) return;
    const name = sd.name || site.site_name || document.title;
    const url = sd.url || site.site_url || location.origin;
    const schema = {
      '@context': 'https://schema.org',
      '@type': sd.type || 'Hotel',
      name,
      url,
    };
    if (sd.description) schema.description = sd.description;
    if (sd.telephone) schema.telephone = sd.telephone;
    if (sd.email) schema.email = sd.email;
    if (sd.street || sd.city) schema.address = {
      '@type': 'PostalAddress',
      streetAddress: sd.street || '',
      addressLocality: sd.city || '',
      addressRegion: sd.region || '',
      postalCode: sd.postal_code || '',
      addressCountry: sd.country || 'IT',
    };
    if (sd.official_rating) schema.starRating = { '@type': 'Rating', ratingValue: sd.official_rating };
    if (sd.latitude && sd.longitude) schema.geo = { '@type': 'GeoCoordinates', latitude: sd.latitude, longitude: sd.longitude };
    if (sd.checkin_time) schema.checkinTime = sd.checkin_time;
    if (sd.checkout_time) schema.checkoutTime = sd.checkout_time;
    if (sd.pets_allowed !== undefined && sd.pets_allowed !== '') schema.petsAllowed = sd.pets_allowed;
    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.textContent = JSON.stringify(schema);
    document.head.appendChild(el);
  }

  function renderFaqWidget(site) {
    const faqData = site.faq_data || {};
    const items = (faqData.items || []).filter(i => i.status === 'publish' || i.status === 'published' || (!i.status && i.solo_ai !== true));
    if (!items.length) return;

    const hp = site.hotel_profile || {};
    const settings = hp.faq_settings || {};
    const colorPrimary = settings.color_primary || '#d82d6b';
    const colorText = settings.color_text || '#171b33';
    const colorBg = settings.color_bg || '#ffffff';
    const title = settings.page_title || 'Domande frequenti';
    const openFirst = settings.open_first !== false;

    let container = document.getElementById('eletta-faq');
    // Auto-render su pagine /faq anche senza div esplicito
    if (!container && /\/faq\/?(\?|#|$)/.test(window.location.pathname)) {
      container = document.createElement('div');
      container.id = 'eletta-faq';
      document.body.appendChild(container);
    }
    if (!container) return;

    const faqSchema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: items.map(i => ({
        '@type': 'Question',
        name: i.question,
        acceptedAnswer: { '@type': 'Answer', text: i.answer },
      })),
    };
    const schemaEl = document.createElement('script');
    schemaEl.type = 'application/ld+json';
    schemaEl.textContent = JSON.stringify(faqSchema);
    document.head.appendChild(schemaEl);

    const sorted = [...items].sort((a, b) => (a.menu_order ?? a.order ?? 0) - (b.menu_order ?? b.order ?? 0));

    container.innerHTML = `
      <div class="eletta-faq-widget" style="font-family:inherit;color:${colorText};background:${colorBg}">
        <h2 style="font-size:1.3em;font-weight:800;margin:0 0 16px;color:${colorPrimary}">${esc(title)}</h2>
        ${sorted.map((item, idx) => `
          <div class="eletta-faq-item" style="border:1px solid #e4e4ec;border-radius:8px;margin-bottom:8px;overflow:hidden">
            <button class="eletta-faq-q" data-idx="${idx}" style="width:100%;text-align:left;background:none;border:none;padding:14px 16px;cursor:pointer;font-size:1em;font-weight:600;color:${colorText};display:flex;align-items:center;justify-content:space-between;gap:12px">
              <span>${esc(item.question)}</span>
              <span class="eletta-faq-arrow" style="flex-shrink:0;transition:transform .2s;font-size:.9em;color:${colorPrimary}">${openFirst && idx === 0 ? '▲' : '▼'}</span>
            </button>
            <div class="eletta-faq-a" style="padding:${openFirst && idx === 0 ? '0 16px 14px' : '0 16px'};max-height:${openFirst && idx === 0 ? '1000px' : '0'};overflow:hidden;transition:max-height .3s ease,padding .3s ease;font-size:.95em;line-height:1.6;color:${colorText}">
              ${esc(item.answer)}
            </div>
          </div>`).join('')}
      </div>`;

    container.querySelectorAll('.eletta-faq-q').forEach(btn => {
      btn.addEventListener('click', function () {
        const item = this.closest('.eletta-faq-item');
        const answer = item.querySelector('.eletta-faq-a');
        const arrow = item.querySelector('.eletta-faq-arrow');
        const isOpen = answer.style.maxHeight !== '0px' && answer.style.maxHeight !== '0';
        if (isOpen) {
          answer.style.maxHeight = '0';
          answer.style.padding = '0 16px';
          arrow.textContent = '▼';
          arrow.style.transform = '';
        } else {
          answer.style.maxHeight = '1000px';
          answer.style.padding = '0 16px 14px';
          arrow.textContent = '▲';
        }
      });
    });
  }

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function init() {
    const siteId = getSiteId();
    if (!siteId) return;

    const site = await fetchSite(siteId);
    if (!site) return;

    injectSchema(site);
    if (!(site.hotel_profile || {}).ai_layer_disabled) injectAiLayerLink(siteId);
    renderFaqWidget(site);
    await sendHeartbeat(siteId, site.site_name, site);
    setInterval(function() { sendHeartbeat(siteId, site.site_name, site); }, HEARTBEAT_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
