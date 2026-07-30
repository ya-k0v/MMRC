/**
 * Sidebar component for admin panel
 * Collapsible sidebar with icons and labels (like PasarGuard)
 * @module admin/sidebar
 */

import { escapeHtml } from '../shared/utils.js';
import { logout } from './auth.js';

const SIDEBAR_WIDTH_EXPANDED = 240;
const SIDEBAR_WIDTH_COLLAPSED = 60;
const STORAGE_KEY = 'mmrc_sidebar_collapsed';

/**
 * Create and initialize the sidebar
 * @param {Object} options
 * @param {Function} options.adminFetch - authenticated fetch function
 * @param {Object} options.user - current user object
 * @param {Function} options.onNavigate - callback when navigation changes
 * @returns {Object} sidebar API
 */
export function createSidebar({ adminFetch, user, onNavigate }) {
  const state = {
    collapsed: localStorage.getItem(STORAGE_KEY) === 'true',
    activeSection: 'devices',
    sections: {},
    enabledModules: new Set()
  };

  // Check enabled modules
  async function loadModules() {
    try {
      const resp = await adminFetch('/api/admin/modules');
      if (resp.ok) {
        const data = await resp.json();
        const modules = data.modules || [];
        state.enabledModules = new Set(modules.filter(m => m.enabled).map(m => m.id));
      }
    } catch { }
  }

  // SVG Icons
  const icons = {
    devices: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    settings: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    apk: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    logs: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    restart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    hero: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    speaker: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    chevronLeft: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    chevronRight: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  };

  // Build menu items
  const menuItems = [
    { id: 'devices', label: 'Устройства', icon: icons.devices, adminOnly: false },
    { id: 'users', label: 'Пользователи', icon: icons.users, adminOnly: true },
    { id: 'settings', label: 'Настройки', icon: icons.settings, adminOnly: true },
    { id: 'logs', label: 'Логи сервиса', icon: icons.logs, adminOnly: true },
    { type: 'divider' },
    { id: 'hero', label: 'Картотека', icon: icons.hero, adminOnly: true, external: '/hero/admin.html', moduleRequired: 'hero' },
    { id: 'speaker', label: 'Спикер', icon: icons.speaker, adminOnly: false, external: '/speaker.html' }
  ];

  // Create sidebar element
  const sidebar = document.createElement('aside');
  sidebar.id = 'adminSidebar';
  sidebar.className = `sidebar${state.collapsed ? ' collapsed' : ''}`;

  // Render sidebar content
  function render() {
    const isAdmin = user.role === 'admin';
    const filteredItems = menuItems.filter(item => {
      if (item.type === 'divider') return true;
      if (item.adminOnly && !isAdmin) return false;
      if (item.moduleRequired && !state.enabledModules.has(item.moduleRequired)) return false;
      return true;
    });

    sidebar.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span class="sidebar-logo-icon">${icons.devices}</span>
          <span class="sidebar-logo-text">MMRC</span>
        </div>
        <button class="sidebar-toggle" title="${state.collapsed ? 'Развернуть' : 'Свернуть'}">
          ${state.collapsed ? icons.chevronRight : icons.chevronLeft}
        </button>
      </div>
      <nav class="sidebar-nav">
        ${filteredItems.map(item => {
          if (item.type === 'divider') {
            return '<div class="sidebar-divider"></div>';
          }
          const isActive = state.activeSection === item.id;
          const target = item.external ? `href="${item.external}" target="_blank"` : `href="#" data-section="${item.id}"`;
          return `
            <a class="sidebar-item${isActive ? ' active' : ''}" ${target} title="${item.label}">
              <span class="sidebar-item-icon">${item.icon}</span>
              <span class="sidebar-item-label">${item.label}</span>
            </a>
          `;
        }).join('')}
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-user">
          <div class="sidebar-user-avatar">${(user.full_name || user.username || 'A')[0].toUpperCase()}</div>
          <span class="sidebar-user-name">${escapeHtml(user.full_name || user.username || 'Admin')}</span>
        </div>
        <button class="sidebar-logout sidebar-logout-btn" id="logoutBtn" title="Выйти">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    `;

    // Bind events
    bindEvents();
  }

  function bindEvents() {
    // Toggle button
    const toggleBtn = sidebar.querySelector('.sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.onclick = (e) => {
        e.preventDefault();
        toggle();
      };
    }

    // Navigation items
    sidebar.querySelectorAll('.sidebar-item[data-section]').forEach(item => {
      item.onclick = (e) => {
        e.preventDefault();
        const section = item.dataset.section;
        if (section) {
          setActiveSection(section);
        }
      };
    });

    // Logout button
    const logoutBtn = sidebar.querySelector('#logoutBtn');
    if (logoutBtn) {
      logoutBtn.onclick = (e) => {
        e.preventDefault();
        logout();
      };
    }
  }

  function toggle() {
    state.collapsed = !state.collapsed;
    localStorage.setItem(STORAGE_KEY, String(state.collapsed));
    sidebar.classList.toggle('collapsed', state.collapsed);
    document.body.classList.toggle('sidebar-collapsed', state.collapsed);
    
    // Update toggle icon
    const toggleBtn = sidebar.querySelector('.sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = state.collapsed ? icons.chevronRight : icons.chevronLeft;
      toggleBtn.title = state.collapsed ? 'Развернуть' : 'Свернуть';
    }

    // Update main content margin
    updateLayout();

    // Notify navigation change
    if (onNavigate) {
      onNavigate(state.activeSection, 'toggle');
    }
  }

  function setActiveSection(sectionId) {
    state.activeSection = sectionId;
    
    // Update active state in sidebar
    sidebar.querySelectorAll('.sidebar-item').forEach(item => {
      item.classList.toggle('active', item.dataset.section === sectionId);
    });

    // On mobile, close sidebar after selection
    if (window.innerWidth < 768) {
      closeMobile();
    }

    // Notify navigation change
    if (onNavigate) {
      onNavigate(sectionId, 'navigate');
    }
  }

  function updateLayout() {
    const mainContent = document.querySelector('.admin-main');
    if (mainContent) {
      const width = state.collapsed ? SIDEBAR_WIDTH_COLLAPDED : SIDEBAR_WIDTH_EXPANDED;
      mainContent.style.marginLeft = `${width}px`;
    }
  }

  function openMobile() {
    sidebar.classList.add('mobile-open');
    updateLayout();
  }

  function closeMobile() {
    sidebar.classList.remove('mobile-open');
    const mainContent = document.querySelector('.admin-main');
    if (mainContent) {
      mainContent.style.marginLeft = '';
    }
  }

  function toggleMobile() {
    if (sidebar.classList.contains('mobile-open')) {
      closeMobile();
    } else {
      openMobile();
    }
  }

  // Initialize
  async function init() {
    document.body.appendChild(sidebar);
    render();
    updateLayout();
    await loadModules();
    render();
  }

  return {
    init,
    toggle,
    toggleMobile,
    openMobile,
    closeMobile,
    setActiveSection,
    getActiveSection: () => state.activeSection,
    isCollapsed: () => state.collapsed
  };
}