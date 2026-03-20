/**
 * KYN Search UI - App Logic
 * Features: exact match, fuzzy, time-intent, location-intent,
 *           suggestions (2+ chars), recent searches (5, LRU), tab filters
 */

// ─── Config ────────────────────────────────────────────────────────────────

let TS_CONFIG = {
  host: "typesense.kynhood.com",
  port: "443",
  protocol: "https",
  apiKey: "ce71fcfb1baa87db70bb514153",
};

const COLLECTIONS = {
  EVENTS: 'kyn_events',
  SPACES: 'kyn_spaces',
  PROFILES: 'kyn_profiles',
  POSTS: 'kyn_posts',
  HASHTAGS: 'kyn_hashtags',
};

// ─── Time Intent Parsing ───────────────────────────────────────────────────

const INTENT_PATTERNS = [
  {
    key: 'today',
    regex: /\btoday\b/i,
    label: '📅 Today',
    getRange() {
      const s = new Date(); s.setHours(0,0,0,0);
      const e = new Date(); e.setHours(23,59,59,999);
      return [Math.floor(s/1000), Math.floor(e/1000)];
    },
  },
  {
    key: 'this_week',
    regex: /\bthis\s+week\b/i,
    label: '📅 This Week',
    getRange() {
      const now = new Date();
      const mon = new Date(now); mon.setDate(now.getDate() - now.getDay() + 1); mon.setHours(0,0,0,0);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23,59,59,999);
      return [Math.floor(mon/1000), Math.floor(sun/1000)];
    },
  },
  {
    key: 'this_weekend',
    regex: /\bthis\s+weekend\b/i,
    label: '📅 This Weekend',
    getRange() {
      const now = new Date();
      const sat = new Date(now); sat.setDate(now.getDate() + (6 - now.getDay() + 7) % 7);
      sat.setHours(0,0,0,0);
      const sun = new Date(sat); sun.setDate(sat.getDate() + 1); sun.setHours(23,59,59,999);
      return [Math.floor(sat/1000), Math.floor(sun/1000)];
    },
  },
  {
    key: 'next_month',
    regex: /\bnext\s+month\b/i,
    label: '📅 Next Month',
    getRange() {
      const now = new Date();
      const s = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
      return [Math.floor(s/1000), Math.floor(e/1000)];
    },
  },
  {
    key: 'near_me',
    regex: /\bnear\s+me\b/i,
    label: '📍 Near Me',
    getRange() { return null; },
  },
  {
    key: 'things_todo',
    regex: /\bthings?\s+to\s+do\b/i,
    label: '🎯 Things To Do',
    getRange() {
      const now = new Date();
      const s = new Date(now); s.setHours(0,0,0,0);
      const e = new Date(s); e.setDate(s.getDate() + 7); e.setHours(23,59,59,999);
      return [Math.floor(s/1000), Math.floor(e/1000)];
    },
  },
];

// Location keywords that indicate a city/area override
const CITY_PATTERNS = [
  /\bin\s+([A-Za-z\s]+?)(?:\s+this|\s+next|\s+today|$)/i,
  /\bat\s+([A-Za-z\s]+?)(?:\s+this|\s+next|\s+today|$)/i,
];

function parseIntent(query) {
  const intents = [];
  let cleanQuery = query;
  let dateRange = null;
  let locationOverride = null;
  let isNearMe = false;

  for (const intent of INTENT_PATTERNS) {
    if (intent.regex.test(query)) {
      intents.push(intent.label);
      cleanQuery = cleanQuery.replace(intent.regex, ' ').trim();
      if (intent.key === 'near_me') {
        isNearMe = true;
      } else if (!dateRange) {
        dateRange = intent.getRange();
      }
    }
  }

  // Check for location override
  for (const pattern of CITY_PATTERNS) {
    const m = query.match(pattern);
    if (m) {
      locationOverride = m[1].trim();
      cleanQuery = cleanQuery.replace(pattern, ' ').trim();
    }
  }

  // Clean up extra spaces
  cleanQuery = cleanQuery.replace(/\s+/g, ' ').trim();

  return { intents, cleanQuery, dateRange, locationOverride, isNearMe };
}

// ─── Typesense API ─────────────────────────────────────────────────────────

function tsBaseUrl() {
  return `${TS_CONFIG.protocol}://${TS_CONFIG.host}:${TS_CONFIG.port}`;
}

async function tsRequest(path, body = null, method = 'GET') {
  const url = `${tsBaseUrl()}${path}`;
  const opts = {
    method: body ? 'POST' : method,
    headers: {
      'X-TYPESENSE-API-KEY': TS_CONFIG.apiKey,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Typesense ${res.status}: ${await res.text()}`);
  return res.json();
}

async function healthCheck() {
  return tsRequest('/health');
}

// Build event filter
function buildEventFilter(dateRange, locationOverride, userZone) {
  const parts = ['isActive:true', 'isDeleted:false'];
  if (dateRange) {
    parts.push(`startDate:>=${dateRange[0]} && startDate:<=${dateRange[1]}`);
  }
  if (locationOverride) {
    parts.push(`locationValue:${locationOverride}`);
  } else if (userZone) {
    // If no explicit location, prioritize user's zone — Typesense doesn't support soft-boost
    // We sort by zone match; just filter is not needed unless strict
  }
  return parts.join(' && ');
}

async function multiSearch(query, activeTab, options = {}) {
  const { dateRange, locationOverride, isNearMe, pages = {} } = options;

  const eventFilter = buildEventFilter(dateRange, locationOverride, null);
  const sortByEvents = 'isPromoted:desc,bookedCount:desc,startDate:asc';

  // Determine which collections to search
  const isSingle = activeTab !== 'all';
  const perPage = isSingle ? 20 : 6;

  const searches = [];
  const keys = [];

  if (activeTab === 'all' || activeTab === 'events') {
    keys.push('events');
    searches.push({
      collection: COLLECTIONS.EVENTS,
      q: query || '*',
      query_by: 'name,venue,locationValue,description,category',
      query_by_weights: '5,3,2,2,1',
      num_typos: 2,
      typo_tokens_threshold: 1,
      filter_by: eventFilter,
      sort_by: sortByEvents,
      per_page: perPage,
      page: pages.events || 1,
      highlight_full_fields: 'name,venue,locationValue',
      snippet_threshold: 30,
    });
  }

  if (activeTab === 'all' || activeTab === 'spaces') {
    keys.push('spaces');
    searches.push({
      collection: COLLECTIONS.SPACES,
      q: query || '*',
      query_by: 'name,description,ownerName,ownerUserName',
      query_by_weights: '4,2,1,1',
      num_typos: 2,
      filter_by: 'isDeleted:false',
      sort_by: 'engagementScore:desc',
      per_page: perPage,
      page: pages.spaces || 1,
      highlight_full_fields: 'name',
    });
  }

  if (activeTab === 'all' || activeTab === 'profiles') {
    keys.push('profiles');
    searches.push({
      collection: COLLECTIONS.PROFILES,
      q: query || '*',
      query_by: 'firstName,userName',
      query_by_weights: '3,2',
      num_typos: 2,
      filter_by: 'isActive:true',
      sort_by: 'postCount:desc',
      per_page: perPage,
      page: pages.profiles || 1,
      highlight_full_fields: 'firstName,userName',
    });
  }

  if (activeTab === 'all' || activeTab === 'posts') {
    keys.push('posts');
    searches.push({
      collection: COLLECTIONS.POSTS,
      q: query || '*',
      query_by: 'title,description',
      query_by_weights: '3,2',
      num_typos: 2,
      filter_by: 'isDeleted:false && isActive:true',
      sort_by: 'viewCount:desc',
      per_page: perPage,
      page: pages.posts || 1,
      highlight_full_fields: 'title',
    });
  }

  if (activeTab === 'all' || activeTab === 'hashtags') {
    keys.push('hashtags');
    searches.push({
      collection: COLLECTIONS.HASHTAGS,
      q: query || '*',
      query_by: 'hashtagName',
      num_typos: 2,
      filter_by: 'isActive:true && isDeleted:false',
      sort_by: 'totalCount:desc,eventCount:desc,createdAt:asc',
      per_page: perPage,
      page: pages.hashtags || 1,
      highlight_full_fields: 'hashtagName',
    });
  }

  if (searches.length === 0) return {};

  const data = await tsRequest('/multi_search', { searches });

  const results = {};
  (data.results || []).forEach((r, i) => {
    results[keys[i]] = r;
  });
  return results;
}

async function getSuggestions(query) {
  if (!query || query.length < 2) return [];
  // Suppress on special-char only
  if (/^[^a-zA-Z0-9#]+$/.test(query)) return [];

  const searches = [
    {
      collection: COLLECTIONS.EVENTS,
      q: query,
      query_by: 'name,venue',
      num_typos: 1,
      filter_by: 'isActive:true && isDeleted:false',
      sort_by: 'bookedCount:desc',
      per_page: 2,
    },
    {
      collection: COLLECTIONS.SPACES,
      q: query,
      query_by: 'name',
      num_typos: 1,
      filter_by: 'isDeleted:false',
      sort_by: 'engagementScore:desc',
      per_page: 2,
    },
    {
      collection: COLLECTIONS.PROFILES,
      q: query,
      query_by: 'firstName,userName',
      num_typos: 1,
      filter_by: 'isActive:true',
      per_page: 2,
    },
    {
      collection: COLLECTIONS.HASHTAGS,
      q: query,
      query_by: 'hashtagName',
      num_typos: 1,
      filter_by: 'isActive:true',
      sort_by: 'totalCount:desc',
      per_page: 2,
    },
    {
      collection: COLLECTIONS.POSTS,
      q: query,
      query_by: 'title',
      num_typos: 1,
      filter_by: 'isDeleted:false && isActive:true',
      sort_by: 'viewCount:desc',
      per_page: 1,
    },
  ];

  const data = await tsRequest('/multi_search', { searches });
  const suggestions = [];

  const typeMap = ['event', 'space', 'profile', 'hashtag', 'post'];
  const iconMap = { event: '🎟️', space: '👥', profile: '👤', hashtag: '#', post: '📝' };
  const colorMap = {
    event: '#8b5cf6', space: '#0ea5e9', profile: '#f43f5e', hashtag: '#10b981', post: '#f59e0b'
  };

  (data.results || []).forEach((r, i) => {
    const type = typeMap[i];
    (r.hits || []).forEach(hit => {
      const doc = hit.document;
      let label = '';
      if (type === 'event') label = doc.name;
      else if (type === 'space') label = doc.name;
      else if (type === 'profile') label = doc.firstName || doc.userName;
      else if (type === 'hashtag') label = '#' + doc.hashtagName;
      else if (type === 'post') label = doc.title || doc.description?.substring(0, 50);
      if (label) {
        suggestions.push({ type, label, id: doc.id, icon: iconMap[type], color: colorMap[type] });
      }
    });
  });

  return suggestions;
}

// ─── Recent Searches ───────────────────────────────────────────────────────

const RECENT_KEY = 'kyn_recent_searches';
const RECENT_MAX = 5;

function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function saveRecentSearch(term) {
  const trimmed = term.trim();
  if (!trimmed) return;
  let list = getRecentSearches();
  list = list.filter(t => t.toLowerCase() !== trimmed.toLowerCase());
  list.unshift(trimmed);
  list = list.slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function removeRecentSearch(term) {
  let list = getRecentSearches().filter(t => t !== term);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function clearAllRecentSearches() {
  localStorage.removeItem(RECENT_KEY);
}

// ─── DOM Helpers ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const show = el => el?.classList.remove('hidden');
const hide = el => el?.classList.add('hidden');

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp * 1000);
  return d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatPrice(price) {
  if (!price || price === 0) return 'Free';
  return '₹' + Number(price).toLocaleString('en-IN');
}

function highlightText(text, highlights, field) {
  if (!highlights || !text) return escHtml(text || '');
  const hl = highlights.find(h => h.field === field);
  if (hl?.snippet) return hl.snippet;
  return escHtml(text);
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s, max = 120) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ─── Card Renderers ────────────────────────────────────────────────────────

function renderEventCard(hit) {
  const d = hit.document;
  const hl = hit.highlights || [];
  const name = highlightText(d.name, hl, 'name');
  const venue = d.venue ? highlightText(d.venue, hl, 'venue') : '';
  const loc = d.locationValue ? highlightText(d.locationValue, hl, 'locationValue') : '';

  return `
    <div class="card event-card" data-id="${d.id}" data-type="event">
      <div class="event-card-top">
        <div>
          <div class="event-name">${name}</div>
        </div>
        <span class="event-badge">${escHtml(d.category || 'Event')}</span>
      </div>
      <div class="event-meta">
        ${d.startDate ? `<span class="event-meta-item">📅 ${formatDate(d.startDate)}</span>` : ''}
        ${venue || loc ? `<span class="event-meta-item">📍 ${venue || loc}</span>` : ''}
        ${d.type ? `<span class="event-meta-item">${d.type === 'online' ? '🌐' : '🏢'} ${escHtml(d.type)}</span>` : ''}
      </div>
      ${d.description ? `<div class="event-desc">${escHtml(truncate(d.description, 140))}</div>` : ''}
      <div class="event-footer">
        <span class="event-price">${formatPrice(d.minPrice)}</span>
        ${d.isPromoted ? '<span class="promoted-badge">⚡ Promoted</span>' : ''}
        ${d.bookedCount > 0 ? `<span class="event-meta-item" style="font-size:12px">🔥 ${d.bookedCount} booked</span>` : ''}
      </div>
    </div>`;
}

function renderSpaceCard(hit) {
  const d = hit.document;
  const hl = hit.highlights || [];
  const name = highlightText(d.name, hl, 'name');
  const isPrivate = (d.membershipTypes || []).includes('private') && !(d.membershipTypes || []).includes('public');
  const logoHtml = d.logoUrl
    ? `<img src="${escHtml(d.logoUrl)}" alt="" onerror="this.style.display='none'" />`
    : d.name?.charAt(0)?.toUpperCase() || '?';

  return `
    <div class="card space-card" data-id="${d.id}" data-type="space">
      <div class="space-logo">${logoHtml}</div>
      <div class="space-info">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="space-name">${name}</span>
          <span class="space-type-badge ${isPrivate ? 'badge-private' : 'badge-public'}">${isPrivate ? '🔒 Private' : '🌐 Public'}</span>
        </div>
        ${d.description ? `<div class="space-desc">${escHtml(truncate(d.description, 80))}</div>` : ''}
        <div class="space-stats">
          <span class="space-stat"><strong>${d.membersCount || 0}</strong> members</span>
          <span class="space-stat"><strong>${d.postsCount || 0}</strong> posts</span>
          ${d.ownerName ? `<span class="space-stat">by ${escHtml(d.ownerName)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function renderProfileCard(hit) {
  const d = hit.document;
  const hl = hit.highlights || [];
  const name = highlightText(d.firstName, hl, 'firstName');
  const username = highlightText(d.userName, hl, 'userName');
  const initial = (d.firstName || d.userName || '?').charAt(0).toUpperCase();

  return `
    <div class="card profile-card" data-id="${d.id}" data-type="profile">
      <div class="profile-avatar">${escHtml(initial)}</div>
      <div class="profile-info">
        <div class="profile-name">${name}</div>
        <div class="profile-username">@${username}</div>
        <div class="profile-stats">
          ${d.postCount > 0 ? `<span class="profile-stat"><strong>${d.postCount}</strong> posts</span>` : ''}
          ${d.journalCount > 0 ? `<span class="profile-stat"><strong>${d.journalCount}</strong> journals</span>` : ''}
          ${d.shortsCount > 0 ? `<span class="profile-stat"><strong>${d.shortsCount}</strong> shorts</span>` : ''}
        </div>
      </div>
    </div>`;
}

function renderPostCard(hit) {
  const d = hit.document;
  const hl = hit.highlights || [];
  const title = d.title ? highlightText(d.title, hl, 'title') : '(untitled)';
  const desc = d.description ? escHtml(truncate(d.description, 120)) : '';

  return `
    <div class="card post-card" data-id="${d.id}" data-type="post">
      <div class="post-title">${title}</div>
      ${desc ? `<div class="post-desc">${desc}</div>` : ''}
      <div class="post-meta">
        ${d.viewCount > 0 ? `<span class="post-meta-item">👁️ ${d.viewCount}</span>` : ''}
        ${d.likeCount > 0 ? `<span class="post-meta-item">❤️ ${d.likeCount}</span>` : ''}
        ${d.template ? `<span class="post-meta-item">${escHtml(d.template)}</span>` : ''}
      </div>
    </div>`;
}

function renderHashtagCard(hit) {
  const d = hit.document;
  const hl = hit.highlights || [];
  const name = highlightText(d.hashtagName, hl, 'hashtagName');

  return `
    <div class="card hashtag-card" data-id="${d.id}" data-type="hashtag" data-name="${escHtml(d.hashtagName)}">
      <div class="hashtag-icon">#</div>
      <div>
        <div class="hashtag-name">#${name}</div>
        <div class="hashtag-count">${d.totalCount || 0} posts · ${d.eventCount || 0} events</div>
      </div>
    </div>`;
}

// ─── Main UI Logic ─────────────────────────────────────────────────────────

let currentTab = 'all';
let searchDebounceTimer = null;
let suggestDebounceTimer = null;
let lastQuery = '';
let currentPages = { events: 1, spaces: 1, profiles: 1, posts: 1, hashtags: 1 };

function resetPages() {
  currentPages = { events: 1, spaces: 1, profiles: 1, posts: 1, hashtags: 1 };
}

function renderPaginationHTML(key, page, totalPages) {
  if (totalPages <= 1) return '';

  const maxButtons = 5;
  let startPage = Math.max(1, page - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  if (endPage - startPage + 1 < maxButtons) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }

  let html = `<div class="pagination">`;
  html += `<button class="pg-btn pg-prev" data-key="${key}" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>← Prev</button>`;

  if (startPage > 1) {
    html += `<button class="pg-btn" data-key="${key}" data-page="1">1</button>`;
    if (startPage > 2) html += `<span class="pg-ellipsis">…</span>`;
  }

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="pg-btn ${i === page ? 'active' : ''}" data-key="${key}" data-page="${i}">${i}</button>`;
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += `<span class="pg-ellipsis">…</span>`;
    html += `<button class="pg-btn" data-key="${key}" data-page="${totalPages}">${totalPages}</button>`;
  }

  html += `<button class="pg-btn pg-next" data-key="${key}" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>Next →</button>`;
  html += '</div>';
  return html;
}

function renderSection(key, hits, total, renderFn, perPage) {
  const section = $(`section-${key}`);
  const list = $(`list-${key}`);
  const count = $(`count-${key}`);
  const pager = $(`pagination-${key}`);
  if (!section || !list || !count) return;

  if (!hits || hits.length === 0) {
    hide(section);
    if (pager) pager.innerHTML = '';
    return;
  }

  show(section);
  count.textContent = `${total} result${total !== 1 ? 's' : ''}`;
  list.innerHTML = hits.map(renderFn).join('');

  if (pager && perPage) {
    const totalPages = Math.ceil(total / perPage);
    pager.innerHTML = renderPaginationHTML(key, currentPages[key] || 1, totalPages);
  }
}

function renderResults(results, query) {
  const container = $('results-container');
  const noResults = $('no-results');
  const noResultsQuery = $('no-results-query');

  let hasAny = false;
  const perPage = currentTab !== 'all' ? 20 : 6;

  renderSection('events', results.events?.hits, results.events?.found, renderEventCard, perPage);
  renderSection('spaces', results.spaces?.hits, results.spaces?.found, renderSpaceCard, perPage);
  renderSection('profiles', results.profiles?.hits, results.profiles?.found, renderProfileCard, perPage);
  renderSection('posts', results.posts?.hits, results.posts?.found, renderPostCard, perPage);
  renderSection('hashtags', results.hashtags?.hits, results.hashtags?.found, renderHashtagCard, perPage);

  // Check if any section is visible
  const sections = ['events', 'spaces', 'profiles', 'posts', 'hashtags'];
  hasAny = sections.some(k => $(`section-${k}`) && !$(`section-${k}`).classList.contains('hidden'));

  if (hasAny) {
    show(container); hide(noResults);
  } else {
    show(container); show(noResults);
    if (noResultsQuery) noResultsQuery.textContent = query;
  }
}

function showIntentBanner(intents) {
  const banner = $('intent-banner');
  if (!banner) return;
  if (intents.length > 0) {
    banner.textContent = `🎯 Filtering by: ${intents.join(' · ')}`;
    show(banner);
  } else {
    hide(banner);
  }
}

async function performSearch(query, { keepPages = false } = {}) {
  query = query.trim();
  if (!query) {
    hide($('results-container'));
    show($('empty-state'));
    hide($('intent-banner'));
    return;
  }

  if (!keepPages) resetPages();
  if (query !== lastQuery) saveRecentSearch(query);
  lastQuery = query;

  const { intents, cleanQuery, dateRange, locationOverride, isNearMe } = parseIntent(query);
  showIntentBanner(intents);

  hide($('empty-state'));

  // Show loading state
  const sections = ['events', 'spaces', 'profiles', 'posts', 'hashtags'];
  sections.forEach(k => hide($(`section-${k}`)));

  try {
    const results = await multiSearch(cleanQuery || '*', currentTab, {
      dateRange,
      locationOverride,
      isNearMe,
      pages: { ...currentPages },
    });
    renderResults(results, query);
  } catch (err) {
    console.error('Search error:', err);
    show($('results-container'));
    show($('no-results'));
    if ($('no-results-query')) $('no-results-query').textContent = query;
  }
}

function renderRecentSearches() {
  const list = getRecentSearches();
  const section = $('recent-section');
  const ul = $('recent-list');
  if (!section || !ul) return;

  if (list.length === 0) { hide(section); return; }
  show(section);

  ul.innerHTML = list.map(term => `
    <li class="recent-item" data-term="${escHtml(term)}">
      <div class="recent-item-icon">🕐</div>
      <span class="recent-item-text">${escHtml(term)}</span>
      <button class="recent-item-remove" data-remove="${escHtml(term)}" title="Remove">✕</button>
    </li>
  `).join('');
}

async function renderSuggestions(query) {
  const section = $('suggestions-section');
  const ul = $('suggestions-list');
  if (!section || !ul) return;

  if (!query || query.length < 2 || /^[^a-zA-Z0-9#]+$/.test(query)) {
    hide(section); return;
  }

  try {
    const suggestions = await getSuggestions(query);
    if (suggestions.length === 0) { hide(section); return; }

    show(section);
    ul.innerHTML = suggestions.map(s => `
      <li class="suggestion-item" data-label="${escHtml(s.label)}" data-type="${s.type}">
        <div class="suggestion-icon" style="background:${s.color}20;color:${s.color}">${s.icon}</div>
        <span class="suggestion-text">${escHtml(s.label)}</span>
        <span class="suggestion-type-badge" style="background:${s.color}20;color:${s.color}">${s.type}</span>
      </li>
    `).join('');
  } catch (err) {
    console.error('Suggestions error:', err);
    hide(section);
  }
}

function showDropdown() {
  const input = $('search-input').value;
  const dropdown = $('search-dropdown');

  if (!input) {
    renderRecentSearches();
    hide($('suggestions-section'));
    const recent = getRecentSearches();
    recent.length > 0 ? show(dropdown) : hide(dropdown);
  } else {
    show(dropdown);
  }
}

function hideDropdown() {
  setTimeout(() => hide($('search-dropdown')), 150);
}

// ─── Event Listeners ───────────────────────────────────────────────────────

function initEventListeners() {
  const input = $('search-input');
  const clearBtn = $('search-clear');
  const dropdown = $('search-dropdown');

  // Search input
  input.addEventListener('input', () => {
    const val = input.value;
    clearBtn.classList.toggle('hidden', !val);

    clearTimeout(searchDebounceTimer);
    clearTimeout(suggestDebounceTimer);

    if (!val) {
      hide($('results-container'));
      show($('empty-state'));
      hide($('intent-banner'));
      renderRecentSearches();
      hide($('suggestions-section'));
      const recent = getRecentSearches();
      recent.length > 0 ? show(dropdown) : hide(dropdown);
      return;
    }

    show(dropdown);

    // Suggestions after 2 chars (debounced 200ms)
    suggestDebounceTimer = setTimeout(() => renderSuggestions(val), 200);

    // Main search (debounced 400ms)
    searchDebounceTimer = setTimeout(() => performSearch(val), 400);
  });

  input.addEventListener('focus', showDropdown);
  input.addEventListener('blur', hideDropdown);

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      hide(dropdown);
      performSearch(input.value);
    }
    if (e.key === 'Escape') {
      hide(dropdown);
      input.blur();
    }
  });

  // Clear button
  clearBtn.addEventListener('click', () => {
    input.value = '';
    hide(clearBtn);
    hide($('results-container'));
    show($('empty-state'));
    hide($('intent-banner'));
    hide(dropdown);
    input.focus();
  });

  // Dropdown click delegation
  dropdown.addEventListener('mousedown', e => {
    // Recent item click
    const recentItem = e.target.closest('.recent-item');
    if (recentItem && !e.target.closest('[data-remove]')) {
      const term = recentItem.dataset.term;
      input.value = term;
      hide(clearBtn.classList.remove('hidden'));
      clearBtn.classList.remove('hidden');
      hide(dropdown);
      performSearch(term);
      return;
    }

    // Remove recent
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      e.preventDefault();
      removeRecentSearch(removeBtn.dataset.remove);
      renderRecentSearches();
      const recent = getRecentSearches();
      if (recent.length === 0) hide($('recent-section'));
      return;
    }

    // Clear all recent
    if (e.target.id === 'clear-all-recent') {
      e.preventDefault();
      clearAllRecentSearches();
      hide($('recent-section'));
      hide(dropdown);
      return;
    }

    // Suggestion click
    const suggItem = e.target.closest('.suggestion-item');
    if (suggItem) {
      const label = suggItem.dataset.label;
      input.value = label;
      clearBtn.classList.remove('hidden');
      hide(dropdown);
      performSearch(label);
    }
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      if (input.value.trim()) performSearch(input.value);
    });
  });

  // Result card clicks (hashtag → replace search) + pagination
  $('results-container').addEventListener('click', e => {
    // Pagination button
    const pgBtn = e.target.closest('.pg-btn[data-key]');
    if (pgBtn && !pgBtn.disabled) {
      const key = pgBtn.dataset.key;
      const page = parseInt(pgBtn.dataset.page, 10);
      if (key && !isNaN(page)) {
        currentPages[key] = page;
        performSearch(lastQuery, { keepPages: true });
        $(`section-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }

    // Hashtag card click → replace search
    const card = e.target.closest('[data-type]');
    if (!card) return;
    if (card.dataset.type === 'hashtag') {
      const name = '#' + card.dataset.name;
      input.value = name;
      clearBtn.classList.remove('hidden');
      saveRecentSearch(name);
      performSearch(name);
    }
  });
}

// ─── Config Panel ──────────────────────────────────────────────────────────

function initConfig() {
  $('cfg-host').value = TS_CONFIG.host;
  $('cfg-port').value = TS_CONFIG.port;
  $('cfg-protocol').value = TS_CONFIG.protocol;
  $('cfg-key').value = TS_CONFIG.apiKey;

  $('cfg-save').addEventListener('click', async () => {
    const host = $('cfg-host').value.trim();
    const port = $('cfg-port').value.trim();
    const protocol = $('cfg-protocol').value;
    const key = $('cfg-key').value.trim();

    if (!host || !port || !key) {
      $('cfg-status').textContent = '⚠️ All fields are required';
      $('cfg-status').className = 'cfg-status err';
      return;
    }

    $('cfg-status').textContent = 'Connecting…';
    $('cfg-status').className = 'cfg-status';

    TS_CONFIG = { host, port, protocol, apiKey: key };

    try {
      await healthCheck();
      localStorage.setItem('kyn_ts_host', host);
      localStorage.setItem('kyn_ts_port', port);
      localStorage.setItem('kyn_ts_protocol', protocol);
      localStorage.setItem('kyn_ts_key', key);

      $('cfg-status').textContent = '✅ Connected!';
      $('cfg-status').className = 'cfg-status ok';

      setTimeout(() => {
        hide($('config-panel'));
        show($('app'));
      }, 800);
    } catch (err) {
      $('cfg-status').textContent = `❌ ${err.message}`;
      $('cfg-status').className = 'cfg-status err';
    }
  });

  $('open-config').addEventListener('click', () => {
    show($('config-panel'));
  });

  $('config-panel').addEventListener('click', e => {
    if (e.target === $('config-panel')) {
      if (!$('app').classList.contains('hidden')) {
        hide($('config-panel'));
      }
    }
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────

async function init() {
  initConfig();

  // Auto-connect if config exists
  if (TS_CONFIG.apiKey && TS_CONFIG.host) {
    $('cfg-status').textContent = 'Connecting…';
    try {
      await healthCheck();
      hide($('config-panel'));
      show($('app'));
      initEventListeners();
    } catch {
      // Show config panel
      show($('config-panel'));
    }
  } else {
    show($('config-panel'));
  }
}

document.addEventListener('DOMContentLoaded', init);
