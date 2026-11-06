/**
 * App.js - Single Page Application Orchestrator
 * Arquitectura Modular bajo DeepSeek Harness
 */

import { storageService } from './services/storage.service.js';
import { customerService } from './services/customer.service.js';
import { orderService } from './services/order.service.js';
import { printService } from './services/print.service.js';
import { notificationService } from './services/notification.service.js';
import { cloudService } from './services/cloud.service.js';
import { syncService } from './services/sync.service.js';
import { destinationService } from './services/destination.service.js';
import { authService, ROLES, PERMISSIONS } from './services/auth.service.js';
import { supabaseService } from './services/supabase.service.js';
import { productService } from './services/product.service.js';

class App {
  constructor() {
    this.currentView = 'dashboard';
    this.appConfig = null;
    this.selectedOrderForAction = null;
    this.selectedCustomerProfile = null;
    this.waitingWorker = null;
    this.currentOrderCoords = null;
    this.currentDestinationCoords = null;
    this.currentInventoryViewMode = 'cards'; // 'cards' | 'table'
    this.currentStockAdjustMode = 'add'; // 'add' | 'sub' | 'set'
    this.selectedProductForAdjust = null;
  }

  async init() {
    // 1. Cargar configuración inicial
    this.appConfig = await storageService.getSettings();
    this.applyTheme();

    // 2. Inicializar sistema de usuarios por cargo y jerarquías
    await authService.init();

    // 3. Registrar e inicializar Service Worker (PWA Offline & Actualizaciones)
    this.initServiceWorker();
    this.setupPwaInstallHandlers();

    // 4. Inicializar sincronizador y guardián anti-colisión
    this.initSync();

    // 4.5. Limpieza automática de posibles pedidos duplicados fantasmas
    await orderService.cleanDuplicateGhostOrders().catch(console.error);

    // 5. Destinos y productos por defecto solo si la base está totalmente vacía
    await destinationService.seedDefaultDestinationsIfEmpty();
    await productService.seedDefaultProductsIfEmpty();

    // 6. Registrar eventos del DOM
    this.registerEventListeners();

    // 7. Validar estado de autenticación y desplegar vistas según el rol
    const isAuthenticated = this.checkAuthenticationState();
    if (isAuthenticated) {
      if (authService.isDispatcher()) {
        this.switchView('orders');
      } else {
        this.switchView('dashboard');
      }
      this.updateGlobalBadgeMetrics();
    }
  }

  // ==========================================
  // Manejo de Service Worker & Actualizaciones
  // ==========================================
  initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('./sw.js').then((registration) => {
      console.log('[App] Service Worker registrado correctamente:', registration.scope);
      this.swRegistration = registration;

      // 1. Forzar consulta de actualización inmediata si el dispositivo tiene conexión a internet
      if (navigator.onLine) {
        registration.update().catch((err) => {
          console.log('[App] Comprobación inicial de actualización:', err);
        });
      }

      // 2. Si ya hay un Service Worker esperando activación
      if (registration.waiting) {
        this.handlePendingUpdate(registration.waiting);
      }

      // 3. Monitorear si se encuentra un nuevo Service Worker en el servidor
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              // Nueva versión descargada y lista
              this.handlePendingUpdate(newWorker);
            }
          }
        });
      });
    }).catch((err) => {
      console.warn('[App] Error al registrar Service Worker:', err);
    });

    // 4. Consultar actualizaciones al recuperar conexión a internet
    window.addEventListener('online', () => {
      console.log('[App] Conexión a internet reanudada: verificando actualizaciones...');
      if (this.swRegistration) {
        this.swRegistration.update().catch(() => {});
      }
    });

    // 5. Consultar actualizaciones cuando el usuario regresa a la aplicación o pestaña
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine && this.swRegistration) {
        this.swRegistration.update().catch(() => {});
      }
    });

    // 6. Cuando el nuevo Service Worker toma el control, recargar suavemente
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  handlePendingUpdate(worker) {
    this.waitingWorker = worker;

    // Si el usuario aún no ha iniciado sesión o el dispositivo está en configuración inicial,
    // aplicar la actualización automáticamente de inmediato para que siempre vea la última versión
    if (!authService.isAuthenticated()) {
      console.log('[App] Dispositivo sin sesión o en configuración inicial: aplicando actualización automáticamente...');
      const statusBox = document.getElementById('initSupabaseStatusBox');
      if (statusBox) {
        statusBox.style.display = 'block';
        statusBox.innerHTML = '🔄 <strong>Nueva versión detectada:</strong> Actualizando aplicación automáticamente...';
      }
      worker.postMessage({ type: 'SKIP_WAITING' });
      return;
    }

    // Si ya tiene sesión activa y está trabajando, mostrar el banner superior
    this.showUpdateBanner(worker);
  }

  showUpdateBanner(worker) {
    this.waitingWorker = worker;
    const banner = document.getElementById('appUpdateBanner');
    if (banner) {
      banner.style.display = 'flex';
    }
  }

  applyAppUpdate() {
    if (this.waitingWorker) {
      this.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      this.forcePurgeAndReload();
    }
  }

  // Forzar actualización total eliminando cachés locales obsoletas y service workers
  async forcePurgeAndReload() {
    try {
      localStorage.removeItem('supabase_unsupported_columns_v1');
      await orderService.cleanDuplicateGhostOrders().catch(() => {});
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          await reg.unregister();
        }
      }
      if ('caches' in window) {
        const cacheKeys = await caches.keys();
        for (const key of cacheKeys) {
          await caches.delete(key);
        }
      }
    } catch (e) {
      console.warn('[App] Error purgando cachés:', e);
    }
    const cleanUrl = window.location.origin + window.location.pathname + '?t=' + Date.now();
    window.location.replace(cleanUrl);
  }

  async checkForAppUpdates(manual = false) {
    if (!('serviceWorker' in navigator)) {
      if (manual) this.showToast('Tu navegador no soporta Service Workers offline.', 'warning');
      return;
    }

    if (!navigator.onLine) {
      if (manual) this.showToast('No hay conexión a internet activa para buscar actualizaciones.', 'warning');
      return;
    }

    if (manual) {
      this.showToast('Buscando actualizaciones en el servidor...', 'info');
    }

    try {
      const reg = this.swRegistration || await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
        if (manual && !reg.waiting && !reg.installing) {
          this.showToast('✅ Ya cuentas con la versión más reciente instalada.', 'success');
        }
      } else {
        if (manual) this.showToast('Service Worker no inicializado aún.', 'info');
      }
    } catch (err) {
      console.warn('[App] Error al buscar actualización:', err);
      if (manual) this.showToast('Error al comprobar versión: ' + err.message, 'danger');
    }
  }

  // ==========================================
  // Manejo de Instalación PWA (Android / iOS / PC)
  // ==========================================
  setupPwaInstallHandlers() {
    this.deferredInstallPrompt = null;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    this.updatePwaStatusUI(isStandalone);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
      console.log('[PWA] Evento beforeinstallprompt capturado. Listo para instalación en Android/PC.');

      if (!isStandalone) {
        const dismissed = sessionStorage.getItem('pwa_banner_dismissed') === 'true';
        if (!dismissed) {
          const banner = document.getElementById('pwaInstallBanner');
          if (banner) banner.style.display = 'flex';
        }

        const navBtn = document.getElementById('btnInstallPwaNavbar');
        if (navBtn) navBtn.style.display = 'inline-flex';

        this.updatePwaStatusUI(false, true);
      }
    });

    window.addEventListener('appinstalled', () => {
      console.log('[PWA] Aplicación instalada exitosamente.');
      this.deferredInstallPrompt = null;
      this.hidePwaBanner();
      this.updatePwaStatusUI(true);
      this.showToast('🎉 ¡Sistema de Encargos instalado exitosamente en tu teléfono!');
    });

    try {
      window.matchMedia('(display-mode: standalone)').addEventListener('change', (evt) => {
        this.updatePwaStatusUI(evt.matches);
      });
    } catch (e) {}
  }

  async triggerPwaInstall() {
    if (this.deferredInstallPrompt) {
      try {
        this.deferredInstallPrompt.prompt();
        const { outcome } = await this.deferredInstallPrompt.userChoice;
        console.log(`[PWA] Elección del usuario: ${outcome}`);
        if (outcome === 'accepted') {
          this.showToast('📲 Instalando en el dispositivo...');
          this.hidePwaBanner();
          this.closeModal('pwaInstallModal');
        }
        this.deferredInstallPrompt = null;
      } catch (err) {
        console.warn('[PWA] Error al invocar prompt:', err);
        this.openPwaHelpModal();
      }
    } else {
      this.openPwaHelpModal();
    }
  }

  dismissPwaBanner() {
    this.hidePwaBanner();
    sessionStorage.setItem('pwa_banner_dismissed', 'true');
  }

  hidePwaBanner() {
    const banner = document.getElementById('pwaInstallBanner');
    if (banner) banner.style.display = 'none';
  }

  openPwaHelpModal() {
    this.openModal('pwaInstallModal');
  }

  updatePwaStatusUI(isInstalled, canPrompt = false) {
    const badge = document.getElementById('pwaSettingsStatusBadge');
    const settingsBtn = document.getElementById('btnInstallPwaSettings');
    const navBtn = document.getElementById('btnInstallPwaNavbar');

    if (isInstalled) {
      if (badge) {
        badge.innerHTML = '🟢 App Instalada (Standalone)';
        badge.style.color = 'var(--color-success)';
      }
      if (settingsBtn) {
        settingsBtn.innerHTML = '<span>✅</span> Aplicación ya Instalada';
        settingsBtn.classList.remove('btn-primary');
        settingsBtn.classList.add('btn-secondary');
      }
      if (navBtn) navBtn.style.display = 'none';
      this.hidePwaBanner();
    } else if (canPrompt) {
      if (badge) {
        badge.innerHTML = '📲 Lista para Instalar (1 Clic)';
        badge.style.color = 'var(--brand-primary)';
      }
      if (settingsBtn) {
        settingsBtn.innerHTML = '<span>📲</span> Instalar en este Dispositivo';
        settingsBtn.classList.add('btn-primary');
        settingsBtn.classList.remove('btn-secondary');
      }
    } else {
      if (badge) {
        badge.innerHTML = '🌐 Modo Navegador Web';
        badge.style.color = 'var(--text-secondary)';
      }
    }
  }

  // ==========================================
  // Sincronización Nube & Estado de Red
  // ==========================================
  initSync() {
    const badgeText = document.getElementById('syncStatusText');
    const badge = document.getElementById('syncStatusBadge');
    const dot = badge?.querySelector('.sync-dot');

    const renderBadge = (status, details) => {
      if (badgeText) badgeText.textContent = details;
      if (dot) {
        dot.className = 'sync-dot';
        if (status === 'realtime_active') {
          dot.classList.add('realtime');
        } else if (status === 'synced' || status === 'connected') {
          dot.classList.add('online');
        } else if (status === 'offline') {
          dot.classList.add('offline');
        } else if (status === 'syncing' || status === 'connecting') {
          dot.classList.add('syncing');
        } else if (status === 'error') {
          dot.classList.add('error');
        } else {
          dot.classList.add('online');
        }
      }
    };

    // Observar estado general de syncService
    syncService.onStatusChange((status, details) => {
      renderBadge(status, details);
    });

    // Observar estado granular de Supabase Realtime
    supabaseService.onStatusChange((status, details) => {
      renderBadge(status, details);
    });

    // Escuchar eventos en tiempo real para todas las tablas
    supabaseService.onSyncEvent(({ table, eventType }) => {
      console.log(`[App] Evento Realtime recibido: ${eventType} en tabla "${table}"`);
      this.refreshCurrentView();
      this.updateGlobalBadgeMetrics();

      const tableLabels = {
        orders: 'Encargo',
        customers: 'Cliente',
        destinations: 'Destino',
        users: 'Usuario',
        settings: 'Configuración',
        products: 'Inventario / Catálogo'
      };
      const actionLabels = {
        INSERT: 'nuevo agregado',
        UPDATE: 'actualizado',
        DELETE: 'eliminado'
      };
      const label = tableLabels[table] || table;
      const action = actionLabels[eventType] || 'sincronizado';
      this.showToast(`⚡ En Vivo: ${label} ${action}`, 'info');
    });

    // Inicializar conexión con Supabase desde credenciales y sincronizar
    setTimeout(async () => {
      await supabaseService.initFromSettings();
      syncService.syncWithCloud();
    }, 1000);
  }

  // ==========================================
  // Manejo de Temas (Dark / Light)
  // ==========================================
  applyTheme() {
    const savedTheme = localStorage.getItem('theme_mode') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
      themeBtn.innerHTML = savedTheme === 'dark' ? '☀️' : '🌙';
    }
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme_mode', next);
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
      themeBtn.innerHTML = next === 'dark' ? '☀️' : '🌙';
    }
  }

  // ==========================================
  // Notificaciones Toast
  // ==========================================
  showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️');
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ==========================================
  // Enrutador de Vistas
  // ==========================================
  switchView(viewName) {
    if (viewName === 'finalized') {
      this.currentOrderGroup = 'finalizados';
      viewName = 'orders';
    } else if (viewName === 'orders') {
      this.currentOrderGroup = 'activos';
    }

    // Guardián de seguridad según rol:
    if (viewName === 'settings' && !authService.isAdmin()) {
      this.showToast('Acceso restringido: Configuración reservada para Administradores.', 'warning');
      this.switchView('orders');
      return;
    }
    if ((viewName === 'dashboard' || viewName === 'customers') && !authService.isAdmin()) {
      this.switchView('orders');
      return;
    }
    if (viewName === 'inventory' && !authService.isAdmin() && !authService.hasPermission(PERMISSIONS.VIEW_INVENTORY)) {
      this.showToast('Acceso restringido: Inventario reservado para Administradores.', 'warning');
      this.switchView('orders');
      return;
    }

    this.currentView = viewName;

    // Actualizar tabs activas en navbar
    document.querySelectorAll('.nav-tab').forEach(tab => {
      if (tab.dataset.view === 'orders') {
        tab.classList.toggle('active', this.currentView === 'orders' && this.currentOrderGroup !== 'finalizados');
      } else if (tab.dataset.view === 'finalized') {
        tab.classList.toggle('active', this.currentView === 'orders' && this.currentOrderGroup === 'finalizados');
      } else {
        tab.classList.toggle('active', tab.dataset.view === this.currentView);
      }
    });

    // Actualizar secciones de vista
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });

    // Cargar contenido según vista
    if (viewName === 'dashboard') this.renderDashboard();
    if (viewName === 'search') this.renderSearchOrders();
    if (viewName === 'orders') this.renderOrders();
    if (viewName === 'destinations') this.renderDestinations();
    if (viewName === 'inventory') this.renderInventory();
    if (viewName === 'customers') this.renderCustomers();
    if (viewName === 'settings') this.renderSettings();
  }

  // Refresca la vista que esté activa actualmente en pantalla
  refreshCurrentView() {
    if (this.currentView === 'dashboard') this.renderDashboard();
    else if (this.currentView === 'search') this.renderSearchOrders();
    else if (this.currentView === 'orders') this.renderOrders();
    else if (this.currentView === 'destinations') this.renderDestinations();
    else if (this.currentView === 'inventory') this.renderInventory();
    else if (this.currentView === 'customers') this.renderCustomers();
    else if (this.currentView === 'settings') this.renderSettings();
  }

  // Determina si un pedido está finalizado (cumple las 3 condiciones: cancelado 100%, productos adquiridos y producto entregado, o está archivado)
  isOrderFinalized(order) {
    if (!order) return false;
    if (order.archivado) return true;
    const isPaid = (order.saldoPendiente === 0 || (order.costoTotal > 0 && order.totalAbonado >= order.costoTotal));
    const isDelivered = Boolean(order.entregado);
    const isAcquired = Boolean(order.adquirido);
    return isPaid && isAcquired && isDelivered;
  }

  async updateGlobalBadgeMetrics() {
    const metrics = await orderService.getDashboardMetrics();
    const currency = this.appConfig?.empresa?.moneda || '$';
    const debtBadge = document.getElementById('globalDebtBadge');
    if (debtBadge) {
      debtBadge.textContent = `Cobros Pendientes: ${currency} ${metrics.totalPorCobrar.toFixed(2)}`;
    }
    const dests = await destinationService.getAllDestinations();
    const destBadge = document.getElementById('destinationsCountBadge');
    if (destBadge) {
      destBadge.textContent = `${dests.length}`;
    }

    // Actualizar contador del catálogo e inventario
    const products = await productService.getAllProducts();
    const invBadge = document.getElementById('inventoryCountBadge');
    if (invBadge) {
      invBadge.textContent = `${products.length}`;
    }
    if (this.currentView === 'inventory') {
      this.renderInventoryMetrics();
    }

    // Actualizar tarjetas de métricas del Dashboard en tiempo real
    const dashDebt = document.getElementById('dashTotalDebt');
    if (dashDebt) dashDebt.textContent = `${currency} ${metrics.totalPorCobrar.toFixed(2)}`;
    const dashCollected = document.getElementById('dashTotalCollected');
    if (dashCollected) dashCollected.textContent = `${currency} ${metrics.totalRecaudado.toFixed(2)}`;
    const dashActive = document.getElementById('dashActiveOrders');
    if (dashActive) dashActive.textContent = `${metrics.totalPedidos}`;
    const dashPending = document.getElementById('dashPendingDeposit');
    if (dashPending) dashPending.textContent = `${metrics.pendientesAnticipoCount}`;

    // Actualizar contadores de navegación y pestañas segmentadas (excluyendo archivados de activos)
    const orders = await orderService.getAllOrders();
    const activeCount = orders.filter(o => o.estado !== 'cancelado' && !o.archivado).length;
    const finCount = orders.filter(o => o.estado !== 'cancelado' && this.isOrderFinalized(o)).length;

    const navActiveBadge = document.getElementById('ordersActiveCountBadge');
    if (navActiveBadge) navActiveBadge.textContent = `${activeCount}`;

    const navFinBadge = document.getElementById('ordersFinalizedNavBadge');
    if (navFinBadge) navFinBadge.textContent = `${finCount}`;

    const badgeActive = document.getElementById('badgeActiveOrdersCount');
    if (badgeActive) badgeActive.textContent = `${activeCount}`;

    const badgeFinalized = document.getElementById('badgeFinalizedOrdersCount');
    if (badgeFinalized) badgeFinalized.textContent = `${finCount}`;

    const badgeAll = document.getElementById('badgeAllOrdersCount');
    if (badgeAll) badgeAll.textContent = `${orders.length}`;
  }

  // ==========================================
  // VISTA 1: DASHBOARD
  // ==========================================
  async renderDashboard() {
    const metrics = await orderService.getDashboardMetrics();
    const currency = this.appConfig?.empresa?.moneda || '$';

    // Rellenar métricas
    document.getElementById('dashTotalDebt').textContent = `${currency} ${metrics.totalPorCobrar.toFixed(2)}`;
    document.getElementById('dashTotalCollected').textContent = `${currency} ${metrics.totalRecaudado.toFixed(2)}`;
    document.getElementById('dashActiveOrders').textContent = metrics.totalPedidos;
    document.getElementById('dashPendingDeposit').textContent = metrics.pendientesAnticipoCount;

    // Renderizar destinos
    const destinationsContainer = document.getElementById('dashDestinationsList');
    if (destinationsContainer) {
      if (metrics.destinos.length === 0) {
        destinationsContainer.innerHTML = `<p class="text-muted" style="padding: 1rem; text-align: center;">No hay envíos registrados.</p>`;
      } else {
        destinationsContainer.innerHTML = metrics.destinos.map(d => {
          const mapsUrl = orderService.getMapsRouteUrl(d.ciudad);
          return `
          <div class="destination-row-item">
            <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="destination-title-link" title="Clic para trazar ruta hacia ${d.ciudad} en Google Maps">
              <span class="destination-pin">📍</span>
              <div>
                <strong class="destination-name">${d.ciudad} <span class="maps-open-tag">🗺️ Ver Ruta ↗</span></strong>
                <div style="font-size: 0.8rem; color: var(--text-secondary);">${d.cantidad} encargo(s) en tránsito</div>
              </div>
            </a>
            <div style="text-align: right; display: flex; align-items: center; gap: 0.75rem;">
              <div>
                <span style="font-weight: 700; color: var(--color-danger); font-family: var(--font-mono);">${currency} ${d.saldoPendiente.toFixed(2)} por cobrar</span>
                <div style="font-size: 0.75rem; color: var(--color-success); font-family: var(--font-mono);">${currency} ${d.totalAbonado.toFixed(2)} recaudado</div>
              </div>
              <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" title="Abrir ruta en Google Maps">
                🗺️ Ruta
              </a>
            </div>
          </div>
        `;
        }).join('');
      }
    }

    // Renderizar encargos más recientes (Solo pedidos activos, excluyendo finalizados)
    const orders = await orderService.getAllOrders();
    const recentOrdersContainer = document.getElementById('dashRecentOrdersList');
    if (recentOrdersContainer) {
      const activeRecent = orders.filter(o => o.estado !== 'cancelado' && !this.isOrderFinalized(o)).slice(0, 5);
      if (activeRecent.length === 0) {
        recentOrdersContainer.innerHTML = `<p class="text-muted" style="padding: 1rem; text-align: center;">No hay encargos activos recientes.</p>`;
      } else {
        recentOrdersContainer.innerHTML = activeRecent.map(o => this.buildOrderCardHtml(o)).join('');
      }
    }
  }

  // ==========================================
  // VISTA 2: BÚSQUEDA RÁPIDA & APARTADOS (Omnibox)
  // ==========================================
  async renderSearchOrders(query = '') {
    const searchInput = document.getElementById('quickSearchInput');
    const q = query !== '' ? query : (searchInput ? searchInput.value : '');

    const orders = await orderService.searchOrdersAndProducts(q);
    const container = document.getElementById('searchResultsContainer');
    const countBadge = document.getElementById('searchCountBadge');

    if (countBadge) countBadge.textContent = `${orders.length} resultado(s)`;

    if (!container) return;

    if (orders.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🔍</div>
          <p style="font-size: 1.1rem; font-weight: 600;">No se encontraron clientes ni productos encargados</p>
          <p style="font-size: 0.875rem;">Intenta buscando con otra palabra o registra un nuevo encargo.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = orders.map(order => this.buildOrderCardHtml(order)).join('');
  }

  // ==========================================
  // VISTA 3: ENCARGOS & APARTADOS (Listado Completo)
  // ==========================================
  // VISTA 3: ENCARGOS & APARTADOS (Listado Completo)
  // ==========================================
  async renderOrders() {
    if (!authService.isAdmin()) {
      this.currentOrderGroup = 'activos';
    } else {
      this.currentOrderGroup = this.currentOrderGroup || 'activos';
    }
    const orders = await orderService.getAllOrders();
    const cityFilter = document.getElementById('orderCityFilter')?.value || 'all';
    const statusFilter = document.getElementById('orderStatusFilter')?.value || 'all';

    // Un encargo está activo en el tablero mientras no esté archivado
    const activeOrders = orders.filter(o => o.estado !== 'cancelado' && !o.archivado);
    const finalizedOrders = orders.filter(o => o.estado !== 'cancelado' && this.isOrderFinalized(o));

    // Actualizar contadores
    const badgeActive = document.getElementById('badgeActiveOrdersCount');
    if (badgeActive) badgeActive.textContent = `${activeOrders.length}`;
    const badgeFinalized = document.getElementById('badgeFinalizedOrdersCount');
    if (badgeFinalized) badgeFinalized.textContent = `${finalizedOrders.length}`;
    const badgeAll = document.getElementById('badgeAllOrdersCount');
    if (badgeAll) badgeAll.textContent = `${orders.length}`;
    const navActiveBadge = document.getElementById('ordersActiveCountBadge');
    if (navActiveBadge) navActiveBadge.textContent = `${activeOrders.length}`;
    const navFinBadge = document.getElementById('ordersFinalizedNavBadge');
    if (navFinBadge) navFinBadge.textContent = `${finalizedOrders.length}`;

    // Actualizar botones de segmento
    document.getElementById('tabGroupActive')?.classList.toggle('active', this.currentOrderGroup === 'activos');
    document.getElementById('tabGroupFinalized')?.classList.toggle('active', this.currentOrderGroup === 'finalizados');
    document.getElementById('tabGroupAll')?.classList.toggle('active', this.currentOrderGroup === 'todos');

    // Actualizar navbar
    document.getElementById('navTabOrders')?.classList.toggle('active', this.currentView === 'orders' && this.currentOrderGroup !== 'finalizados');
    document.getElementById('navTabFinalized')?.classList.toggle('active', this.currentView === 'orders' && this.currentOrderGroup === 'finalizados');

    // Textos de estado
    const titleEl = document.getElementById('ordersViewMainTitle');
    const subtitleEl = document.getElementById('orderGroupSubtitle');
    const descEl = document.getElementById('orderGroupDescription');
    if (this.currentOrderGroup === 'activos') {
      if (titleEl) titleEl.innerHTML = `📦 Encargos Activos`;
      if (subtitleEl) subtitleEl.textContent = 'Control de pedidos en tránsito, compras y pagos por apartado';
      if (descEl) descEl.innerHTML = `Mostrando <strong>${activeOrders.length} pedido(s) activo(s)</strong> (en tránsito o con saldo)`;
    } else if (this.currentOrderGroup === 'finalizados') {
      if (titleEl) titleEl.innerHTML = `🏁 Pedidos Finalizados / Entregados`;
      if (subtitleEl) subtitleEl.textContent = 'Historial de encargos completados, entregados y archivados';
      if (descEl) descEl.innerHTML = `Mostrando <strong>${finalizedOrders.length} pedido(s) finalizado(s)</strong> en historial`;
    } else {
      if (titleEl) titleEl.innerHTML = `📋 Todos los Encargos`;
      if (subtitleEl) subtitleEl.textContent = 'Listado global de todos los encargos activos y archivados';
      if (descEl) descEl.innerHTML = `Mostrando <strong>${orders.length} pedido(s)</strong> en total`;
    }

    // Filtrar por grupo (Activos, Finalizados, Todos)
    let filtered = orders;
    if (this.currentOrderGroup === 'activos') {
      filtered = activeOrders;
    } else if (this.currentOrderGroup === 'finalizados') {
      filtered = finalizedOrders;
    }

    // Poblar opciones del filtro de estado según el grupo
    this.populateStatusFilter(this.currentOrderGroup, statusFilter);

    // Filtrar por estado específico de forma inteligente
    const currentStatusVal = document.getElementById('orderStatusFilter')?.value || 'all';
    if (currentStatusVal !== 'all') {
      if (currentStatusVal === 'por_adquirir') filtered = filtered.filter(o => !o.adquirido && !o.entregado);
      else if (currentStatusVal === 'adquirido') filtered = filtered.filter(o => o.adquirido && !o.entregado);
      else if (currentStatusVal === 'entregado') filtered = filtered.filter(o => o.entregado);
      else if (currentStatusVal === 'entregado_con_deuda') filtered = filtered.filter(o => o.entregado && o.saldoPendiente > 0);
      else if (currentStatusVal === 'cancelado_total') filtered = filtered.filter(o => o.saldoPendiente === 0);
      else if (currentStatusVal === 'pendiente_anticipo') filtered = filtered.filter(o => o.totalAbonado === 0);
      else if (currentStatusVal === 'archivados') filtered = filtered.filter(o => o.archivado);
      else if (currentStatusVal === 'por_archivar') filtered = filtered.filter(o => !o.archivado);
      else filtered = filtered.filter(o => o.estado === currentStatusVal);
    }

    // Poblar selector de ciudades
    this.populateCityFilter(orders);

    // Filtrar por ciudad
    if (cityFilter !== 'all') {
      filtered = filtered.filter(o => o.lugarDestino?.ciudad === cityFilter);
    }

    const container = document.getElementById('ordersListContainer');
    if (!container) return;

    if (filtered.length === 0) {
      let emptyIcon = '📦';
      let emptyTitle = 'No hay pedidos activos actualmente';
      let emptySubtitle = 'Todos los encargos han sido entregados o puedes registrar uno nuevo con el botón superior.';

      if (this.currentOrderGroup === 'finalizados') {
        emptyIcon = '🏁';
        emptyTitle = 'No hay pedidos finalizados / entregados aún';
        emptySubtitle = 'Cuando liquides y entregues un pedido activo, presiona "Archivar Encargo" para guardarlo en esta sección.';
      } else if (this.currentOrderGroup === 'todos' || currentStatusVal !== 'all' || cityFilter !== 'all') {
        emptyIcon = '🔍';
        emptyTitle = 'No hay pedidos con los filtros seleccionados';
        emptySubtitle = 'Intenta seleccionando otra ciudad o cambiando el filtro de estado.';
      }

      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted); grid-column: 1 / -1;">
          <div style="font-size: 2.8rem; margin-bottom: 0.5rem;">${emptyIcon}</div>
          <p style="font-size: 1.15rem; font-weight: 700; color: var(--text-primary); margin-bottom: 0.25rem;">${emptyTitle}</p>
          <p style="font-size: 0.85rem; color: var(--text-secondary); max-width: 480px; margin: 0 auto;">${emptySubtitle}</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(order => this.buildOrderCardHtml(order)).join('');
  }

  setOrderGroupFilter(group) {
    if (!authService.isAdmin() && group !== 'activos') {
      this.currentOrderGroup = 'activos';
      return;
    }
    this.currentOrderGroup = group;
    const statusSelect = document.getElementById('orderStatusFilter');
    if (statusSelect) statusSelect.value = 'all';
    this.renderOrders();
  }

  populateStatusFilter(group, selectedVal = 'all') {
    const select = document.getElementById('orderStatusFilter');
    if (!select) return;

    let options = '';
    if (group === 'activos') {
      options = `
        <option value="all">Todos los estados activos</option>
        <option value="por_adquirir">⏳ Por Comprar / Adquirir</option>
        <option value="adquirido">🛍️ Productos Adquiridos (Por Entregar)</option>
        <option value="cancelado_total">🟢 Totalmente Cancelados (Por Entregar)</option>
        <option value="entregado_con_deuda">📦 Entregados con Saldo Pendiente</option>
        <option value="pendiente_anticipo">🟡 Falta Anticipo</option>
      `;
    } else if (group === 'finalizados') {
      options = `
        <option value="all">Todos los finalizados y entregados</option>
        <option value="por_archivar">⏳ Pendientes por Archivar</option>
        <option value="archivados">📁 Ya Archivados en Historial</option>
        <option value="entregado">📦 Entregados</option>
      `;
    } else {
      options = `
        <option value="all">Todos los pedidos</option>
        <option value="por_adquirir">⏳ Por Adquirir</option>
        <option value="adquirido">🛍️ Productos Adquiridos</option>
        <option value="entregado">📦 Productos Entregados</option>
        <option value="cancelado_total">🟢 Totalmente Cancelados</option>
        <option value="pendiente_anticipo">🟡 Falta Anticipo</option>
      `;
    }

    select.innerHTML = options;
    if (Array.from(select.options).some(o => o.value === selectedVal)) {
      select.value = selectedVal;
    } else {
      select.value = 'all';
    }
  }

  populateCityFilter(orders) {
    const select = document.getElementById('orderCityFilter');
    if (!select) return;

    const currentVal = select.value;
    const cities = new Set();
    orders.forEach(o => {
      if (o.lugarDestino?.ciudad) cities.add(o.lugarDestino.ciudad);
    });

    let options = `<option value="all">Todas las ciudades</option>`;
    cities.forEach(city => {
      options += `<option value="${city}" ${currentVal === city ? 'selected' : ''}>${city}</option>`;
    });
    select.innerHTML = options;
  }

  // ==========================================
  // CONSTRUCTOR DE TARJETA DE ENCARGO / APARTADO
  // (Con los 4 botones clave: Agregar Abono, Cancelación Total, Productos Adquiridos, Producto Entregado)
  // ==========================================
  buildOrderCardHtml(order) {
    const currency = this.appConfig?.empresa?.moneda || '$';
    const isAdmin = authService.isAdmin();
    const defaultPrefix = this.appConfig?.empresa?.prefijoPais || '+58';
    const cleanPhone = order.clienteTelefono ? notificationService.cleanPhoneNumber(order.clienteTelefono, defaultPrefix) : '';
    const waUrl = cleanPhone 
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(notificationService.buildWhatsAppMessage(order, this.appConfig))}`
      : '#';

    // Estados independientes: Financiero y Logístico
    const isPaid = (order.saldoPendiente === 0 || (order.costoTotal > 0 && order.totalAbonado >= order.costoTotal));
    const isDelivered = Boolean(order.entregado);
    const isAcquired = Boolean(order.adquirido);
    const isArchived = Boolean(order.archivado);
    const isFinalized = (isPaid && isAcquired && isDelivered) || isArchived;

    // 1. Marca Financiera
    let financialBadgeHtml = '';
    if (isPaid) {
      financialBadgeHtml = `<span class="status-badge paid">🟢 Cancelado 100%</span>`;
    } else if (order.totalAbonado > 0) {
      financialBadgeHtml = `<span class="status-badge active">🔵 En Abonos (${order.porcentajePagado}%)</span>`;
    } else {
      financialBadgeHtml = `<span class="status-badge pending">🟡 Falta Anticipo</span>`;
    }

    // 2. Marca de Adquisición
    let acquiredBadgeHtml = '';
    if (isAcquired) {
      acquiredBadgeHtml = `<span class="status-badge acquired">🛍️ Adquirido</span>`;
    } else {
      acquiredBadgeHtml = `<span class="status-badge por-comprar">⏳ Por Adquirir</span>`;
    }

    // 3. Marca de Entrega Física
    let deliveryBadgeHtml = '';
    if (isDelivered) {
      deliveryBadgeHtml = `<span class="status-badge delivered">📦 Entregado</span>`;
    } else {
      deliveryBadgeHtml = `<span class="status-badge por-entregar">🚚 Por Entregar</span>`;
    }

    // 4. Marca de Archivado en Historial (si aplica)
    let archivedBadgeHtml = '';
    if (isArchived) {
      archivedBadgeHtml = `<span class="status-badge finalized">📁 Archivado</span>`;
    }

    // Lista de productos compacta
    const productsHtml = (order.items || []).map(it => `
      <div class="product-row-preview">
        <span class="product-name-qty"><strong>${it.cantidad}x</strong> ${it.descripcion}</span>
        <span class="product-price-val">${currency} ${(it.cantidad * it.precioUnitario).toFixed(2)}</span>
      </div>
    `).join('');

    return `
      <div class="order-item-card ${isArchived ? 'order-card-archived' : ''}" data-order-id="${order.id}">
        <!-- Header de la tarjeta -->
        <div class="order-card-header">
          <div class="order-main-info">
            <span class="order-id-badge">${order.id}</span>
            <div class="order-customer-name">
              👤 ${order.clienteNombre}
              <button class="btn btn-icon" style="width: 24px; height: 24px; font-size: 0.75rem;" title="Ver perfil del cliente" onclick="window.app.openCustomerProfile('${order.clienteId}')">ℹ️</button>
            </div>
            <div class="order-meta-info">
              <a href="${orderService.getMapsRouteUrl(order.lugarDestino)}" target="_blank" rel="noopener noreferrer" class="meta-pill meta-pill-clickable" title="Clic para abrir ubicación o ruta en Google Maps">
                📍 ${order.lugarDestino?.ciudad || 'Sin destino'}${order.lugarDestino?.puntoEntrega ? ` (${order.lugarDestino.puntoEntrega})` : ''} <span style="font-size: 0.75rem;">↗</span>
              </a>
              ${order.fechaEntregaEstimada ? `<span class="meta-pill">📅 Fecha estimada: ${order.fechaEntregaEstimada}</span>` : ''}
              ${order.clienteTelefono ? `
                <a href="${waUrl}" target="_blank" rel="noopener noreferrer" class="meta-pill meta-pill-clickable meta-pill-whatsapp" title="Clic para enviar mensaje por WhatsApp a ${order.clienteNombre} (${order.clienteTelefono})">
                  💬 ${order.clienteTelefono} <span style="font-size: 0.75rem;">↗</span>
                </a>
              ` : ''}
            </div>
          </div>
          <div style="display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap;">
            ${financialBadgeHtml}
            ${acquiredBadgeHtml}
            ${deliveryBadgeHtml}
            ${archivedBadgeHtml}
          </div>
        </div>

        <!-- Productos del encargo -->
        <div class="order-products-box">
          ${productsHtml}
          ${order.costoEnvioComision > 0 ? `
            <div class="product-row-preview" style="color: var(--text-secondary); font-size: 0.8rem; border-top: 1px dashed var(--border-color); padding-top: 4px;">
              <span>+ Comisión de traslado / encomienda:</span>
              <span class="product-price-val">${currency} ${order.costoEnvioComision.toFixed(2)}</span>
            </div>
          ` : ''}
        </div>

        <!-- Finanzas y Barra de Progreso del Apartado -->
        <div class="order-finance-progress">
          <div class="finance-stats-row">
            <div class="finance-stat-item">
              <span class="stat-title">COSTO TOTAL</span>
              <span class="stat-amount">${currency} ${order.costoTotal.toFixed(2)}</span>
            </div>
            <div class="finance-stat-item">
              <span class="stat-title">TOTAL ABONADO</span>
              <span class="stat-amount paid">${currency} ${order.totalAbonado.toFixed(2)}</span>
            </div>
            <div class="finance-stat-item">
              <span class="stat-title">SALDO RESTANTE</span>
              <span class="stat-amount ${isPaid ? 'paid' : 'debt'}">
                ${isPaid ? 'PAGADO COMPLETO' : `${currency} ${order.saldoPendiente.toFixed(2)}`}
              </span>
            </div>
          </div>

          <!-- Barra de Progreso de pago del Apartado -->
          <div class="progress-bar-container">
            <div class="progress-bar-fill ${isPaid ? 'complete' : ''}" style="width: ${order.porcentajePagado}%;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted);">
            <span>Anticipo requerido: ${currency} ${order.montoAnticipoCalculado.toFixed(2)} (${order.anticipoExigidoValor}%)</span>
            <span><strong>${order.porcentajePagado}%</strong> pagado</span>
          </div>
        </div>

        <!-- Barra de Acciones: Los 4 botones requeridos + Comprobantes -->
        <div class="order-actions-toolbar">
          <div class="quick-order-actions-grid">
            <!-- 1. Botón: Agregar Abono -->
            ${order.saldoPendiente > 0 ? `
              <button class="btn btn-success" onclick="window.app.openAddPaymentModal('${order.id}')" title="Registrar un abono / cuota de dinero">
                ➕ Agregar Abono
              </button>
            ` : `
              <button class="btn btn-disabled" disabled title="Este pedido ya no tiene saldo pendiente">
                ➕ Agregar Abono
              </button>
            `}

            <!-- 2. Botón: Cancelación Total -->
            ${order.saldoPendiente > 0 ? `
              <button class="btn btn-warning" onclick="window.app.quickFullSettlement('${order.id}')" title="Liquidar el 100% restante en 1 clic">
                ⚡ Cancelación Total
              </button>
            ` : `
              <button class="btn btn-paid-disabled" disabled title="Pedido totalmente cancelado">
                ✅ Totalmente Cancelado
              </button>
            `}

            <!-- 3. Botón: Productos Adquiridos -->
            <button class="btn ${isAcquired ? 'btn-acquired-active' : 'btn-acquired'}" 
                    onclick="window.app.toggleOrderAcquired('${order.id}')" 
                    title="${isAcquired ? 'Productos marcados como adquiridos. Clic para desmarcar.' : 'Marcar que compraste o conseguiste estos productos'}">
              ${isAcquired ? '✅ Productos Adquiridos' : '🛍️ Productos Adquiridos'}
            </button>

            <!-- 4. Botón: Producto Entregado (Requiere haber sido adquirido primero) -->
            ${!isAcquired && !isDelivered ? `
              <button class="btn btn-delivered btn-delivered-locked" 
                      onclick="window.app.toggleOrderDelivered('${order.id}')" 
                      title="⚠️ Bloqueado: Primero debes marcar los productos como adquiridos (🛍️ Productos Adquiridos) antes de poder realizar la entrega física">
                🔒 Producto Entregado
              </button>
            ` : `
              <button class="btn ${isDelivered ? 'btn-delivered-active' : 'btn-delivered'}" 
                      onclick="window.app.toggleOrderDelivered('${order.id}')" 
                      title="${isDelivered ? 'Producto entregado al cliente. Clic para desmarcar.' : 'Marcar que el cliente ya recibió el producto físicamente'}">
                ${isDelivered ? '✅ Producto Entregado' : '📦 Producto Entregado'}
              </button>
            `}
          </div>

          <!-- Comprobantes y Acciones de Salida -->
          <div class="output-actions">
            <button class="btn btn-secondary btn-icon" title="Imprimir Ticket Térmico" onclick="window.app.printTicket('${order.id}')">
              🖨️
            </button>
            <button class="btn btn-secondary btn-icon" title="Enviar por WhatsApp" onclick="window.app.sendWhatsApp('${order.id}')">
              💬
            </button>
            <button class="btn btn-secondary btn-icon" title="Enviar por Email" onclick="window.app.sendEmail('${order.id}')">
              ✉️
            </button>
            ${isAdmin && isDelivered && !isArchived ? `
              <button class="btn btn-secondary btn-icon" title="Archivar pedido en Historial Finalizados (Admin)" onclick="window.app.archiveFinalizedOrder('${order.id}')" style="font-size: 0.85rem;">
                📁
              </button>
            ` : ''}
            ${isAdmin ? `
              <button class="btn btn-secondary btn-icon btn-danger-icon" title="Eliminar definitivamente de la base de datos (Admin)" onclick="window.app.confirmDeleteOrder('${order.id}')" style="font-size: 0.85rem;">
                🗑️
              </button>
            ` : ''}
          </div>
        </div>

        <!-- Franja Exclusiva para Administrador en Pedidos Finalizados / Archivados -->
        ${isAdmin && (isFinalized || (isDelivered && isArchived)) ? `
          <div class="admin-archive-strip ${isArchived ? 'strip-archived' : ''}">
            <span class="admin-strip-text">
              ${isArchived 
                ? '📁 <strong>Encargo Archivado en Historial</strong> (Ya no suma en recaudado del tablero)' 
                : '👑 <strong>Pedido Finalizado</strong> (Pagado 100%, Adquirido y Entregado — Pendiente de archivar)'}
            </span>
            <div class="admin-archive-buttons" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              ${!isArchived ? `
                <button class="btn btn-archive" onclick="window.app.archiveFinalizedOrder('${order.id}')" title="Archivar pedido con sello de historial para que deje de sumar en recaudado activo">
                  📁 Archivar Encargo
                </button>
              ` : `
                <button class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.45rem 0.75rem;" onclick="window.app.unarchiveOrder('${order.id}')" title="Restaurar este pedido a la pantalla de pedidos activos y volver a sumar en recaudado">
                  ↩️ Restaurar a Activos
                </button>
              `}
              <button class="btn btn-danger" style="font-size: 0.825rem; padding: 0.45rem 0.85rem;" onclick="window.app.confirmDeleteOrder('${order.id}')" title="Eliminar definitivamente este encargo de la base de datos">
                🗑️ Eliminar Totalmente
              </button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ==========================================
  // VISTA 4: DIRECTORIO DE CLIENTES
  // ==========================================
  async renderCustomers(query = '') {
    const customers = await customerService.searchCustomers(query);
    const container = document.getElementById('customersListContainer');
    const currency = this.appConfig?.empresa?.moneda || '$';

    if (!container) return;

    if (customers.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">👥</div>
          <p style="font-size: 1.1rem; font-weight: 600;">No se encontraron clientes</p>
        </div>
      `;
      return;
    }

    container.innerHTML = customers.map(c => `
      <div class="order-item-card" style="cursor: pointer;" onclick="window.app.openCustomerProfile('${c.id}')">
        <div class="order-card-header">
          <div>
            <h3 style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">👤 ${c.nombre}</h3>
            <div class="order-meta-info">
              ${c.telefono ? `
                <a href="https://wa.me/${notificationService.cleanPhoneNumber(c.telefono, this.appConfig?.empresa?.prefijoPais || '+58')}" target="_blank" rel="noopener noreferrer" class="meta-pill meta-pill-clickable meta-pill-whatsapp" onclick="event.stopPropagation();" title="Clic para enviar WhatsApp a ${c.nombre} (${c.telefono})">
                  💬 ${c.telefono} <span style="font-size: 0.75rem;">↗</span>
                </a>
              ` : ''}
              ${c.ciudadDefault ? `<span class="meta-pill">📍 ${c.ciudadDefault}</span>` : ''}
              ${c.email ? `<span class="meta-pill">✉️ ${c.email}</span>` : ''}
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">SALDO DEUDOR ACUMULADO</div>
            <div style="font-family: var(--font-mono); font-size: 1.25rem; font-weight: 800; color: ${c.saldoDeudorTotal > 0 ? 'var(--color-danger)' : 'var(--color-success)'};">
              ${currency} ${c.saldoDeudorTotal.toFixed(2)}
            </div>
            <div style="font-size: 0.8rem; color: var(--text-secondary);">${c.totalEncargos} encargo(s)</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  // ==========================================
  // VISTA 5: CONFIGURACIÓN
  // ==========================================
  async renderSettings() {
    await this.applyRolePermissions();

    if (authService.isAdmin()) {
      await this.renderUsers();

      const config = await storageService.getSettings();
      const emp = config.empresa || {};
      const cld = config.cloud || {};

      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
      };

      setVal('setEmpresaNombre', emp.nombre || '');
      setVal('setEmpresaPropietario', emp.propietario || '');
      setVal('setEmpresaTelefono', emp.telefono || '');
      setVal('setEmpresaEmail', emp.email || '');
      setVal('setEmpresaMoneda', emp.moneda || '$');
      setVal('setEmpresaAnticipo', emp.anticipoDefault || 50);
      setVal('setEmpresaPrefijoPais', emp.prefijoPais || '+58');
      setVal('setEmpresaTicketMensaje', emp.mensajeTicket || '');

      setVal('setSupabaseUrl', cld.supabaseUrl || '');
      setVal('setSupabaseKey', cld.supabaseAnonKey || '');
    }
  }

  async saveSettingsFromForm() {
    if (!authService.isAdmin()) {
      alert('Solo un usuario con cargo de Administrador puede guardar cambios de configuración.');
      return;
    }

    const newSettings = {
      empresa: {
        nombre: document.getElementById('setEmpresaNombre').value.trim(),
        propietario: document.getElementById('setEmpresaPropietario').value.trim(),
        telefono: document.getElementById('setEmpresaTelefono').value.trim(),
        email: document.getElementById('setEmpresaEmail').value.trim(),
        moneda: document.getElementById('setEmpresaMoneda').value.trim() || '$',
        anticipoDefault: Number(document.getElementById('setEmpresaAnticipo').value) || 50,
        prefijoPais: document.getElementById('setEmpresaPrefijoPais').value.trim() || '+58',
        mensajeTicket: document.getElementById('setEmpresaTicketMensaje').value.trim()
      },
      cloud: {
        provider: 'supabase',
        supabaseUrl: document.getElementById('setSupabaseUrl').value.trim(),
        supabaseAnonKey: document.getElementById('setSupabaseKey').value.trim()
      }
    };

    await storageService.saveSettings(newSettings);
    this.appConfig = newSettings;

    // Conectar o desconectar Supabase en tiempo real según las credenciales
    if (newSettings.cloud.supabaseUrl && newSettings.cloud.supabaseAnonKey) {
      await supabaseService.initClient(newSettings.cloud.supabaseUrl, newSettings.cloud.supabaseAnonKey, true);
      supabaseService.pushRecord('settings', { key: 'app_config', value: newSettings, updatedAt: new Date().toISOString() }).catch(() => {});
    } else {
      supabaseService.disconnect();
    }

    this.showToast('Configuración guardada correctamente.');
    this.updateGlobalBadgeMetrics();
  }

  // ==========================================
  // VISTA: DESTINOS & RUTAS FRECUENTES
  // ==========================================
  async renderDestinations(query = '') {
    const destinations = await destinationService.searchDestinations(query);
    const container = document.getElementById('destinationsListContainer');
    const badge = document.getElementById('destinationsCountBadge');
    if (badge) badge.textContent = `${destinations.length}`;

    if (!container) return;

    if (destinations.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">📍</div>
          <p style="font-size: 1.1rem; font-weight: 600;">No hay destinos registrados en el catálogo</p>
          <p style="font-size: 0.875rem;">Haz clic en "Agregar Ubicación / Ruta" para guardar paradas de WhatsApp o Google Maps.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = destinations.map(d => {
      const routeUrl = destinationService.getRouteUrl(d);
      let catClass = 'terminal';
      if (d.categoria === 'Almacén / Tienda') catClass = 'almacen';
      else if (d.categoria === 'Punto de Encuentro') catClass = 'encuentro';
      else if (d.categoria === 'Domicilio') catClass = 'domicilio';

      return `
        <div class="order-item-card">
          <div class="order-card-header">
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <h3 style="font-size: 1.15rem; font-weight: 700; color: var(--text-primary);">📍 ${d.nombre}</h3>
                <span class="dest-badge-cat ${catClass}">${d.categoria || 'Punto'}</span>
              </div>
              <div class="order-meta-info" style="margin-top: 0.4rem;">
                <span class="meta-pill">🏙️ ${d.ciudad}</span>
                ${d.direccion ? `<span class="meta-pill">📌 ${d.direccion}</span>` : ''}
                ${d.lat && d.lng ? `<span class="meta-pill">🌐 ${d.lat}, ${d.lng}</span>` : ''}
              </div>
              ${d.notas ? `<p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem; font-style: italic;">📝 ${d.notas}</p>` : ''}
            </div>

            <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              <a href="${routeUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" title="Abrir ruta en Google Maps">
                🗺️ Trazar Ruta en Maps ↗
              </a>
              <button class="btn btn-secondary btn-icon" title="Editar Destino" onclick="window.app.openEditDestinationModal('${d.id}')">
                ✏️
              </button>
              <button class="btn btn-secondary btn-icon" title="Eliminar Destino" onclick="window.app.deleteDestination('${d.id}')">
                🗑️
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  openNewDestinationModal() {
    document.getElementById('destinationModalTitle').textContent = '📍 Registrar Ubicación / Ruta';
    document.getElementById('destEditId').value = '';
    document.getElementById('destNombreInput').value = '';
    document.getElementById('destCiudadInput').value = '';
    document.getElementById('destCategoriaSelect').value = 'Terminal';
    document.getElementById('destDireccionInput').value = '';
    document.getElementById('destMapsUrlInput').value = '';
    document.getElementById('destNotasInput').value = '';
    this.currentDestinationCoords = null;
    this.openModal('destinationModal');
  }

  async openEditDestinationModal(id) {
    const d = await destinationService.getDestinationById(id);
    if (!d) return;

    document.getElementById('destinationModalTitle').textContent = '✏️ Editar Ubicación / Ruta';
    document.getElementById('destEditId').value = d.id;
    document.getElementById('destNombreInput').value = d.nombre || '';
    document.getElementById('destCiudadInput').value = d.ciudad || '';
    document.getElementById('destCategoriaSelect').value = d.categoria || 'Terminal';
    document.getElementById('destDireccionInput').value = d.direccion || '';
    document.getElementById('destMapsUrlInput').value = d.mapsUrl || '';
    document.getElementById('destNotasInput').value = d.notas || '';
    this.currentDestinationCoords = d.lat && d.lng ? { lat: d.lat, lng: d.lng } : null;

    this.openModal('destinationModal');
  }

  captureGPSForDestination() {
    if (!navigator.geolocation) {
      alert('La geolocalización no está disponible en este dispositivo.');
      return;
    }
    this.showToast('Obteniendo coordenadas GPS...', 'info');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(6);
        const lng = pos.coords.longitude.toFixed(6);
        this.currentDestinationCoords = { lat, lng };
        const input = document.getElementById('destMapsUrlInput');
        if (input) input.value = `https://www.google.com/maps?q=${lat},${lng}`;
        this.showToast(`📍 Coordenadas capturadas (${lat}, ${lng})`);
      },
      (err) => alert('Error GPS: ' + err.message),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async submitDestinationForm() {
    const nombre = document.getElementById('destNombreInput').value.trim();
    const ciudad = document.getElementById('destCiudadInput').value.trim();

    if (!nombre || !ciudad) {
      alert('El nombre del punto y la ciudad son obligatorios.');
      return;
    }

    const editId = document.getElementById('destEditId').value;
    const destData = {
      id: editId || undefined,
      nombre,
      ciudad,
      categoria: document.getElementById('destCategoriaSelect').value,
      direccion: document.getElementById('destDireccionInput').value.trim(),
      mapsUrl: document.getElementById('destMapsUrlInput').value.trim(),
      lat: this.currentDestinationCoords?.lat,
      lng: this.currentDestinationCoords?.lng,
      notas: document.getElementById('destNotasInput').value.trim()
    };

    try {
      await destinationService.saveDestination(destData);
      this.closeModal('destinationModal');
      this.showToast(`Ubicación "${nombre}" guardada en el catálogo.`);
      this.renderDestinations();
      this.populateSavedDestinationsSelect();
    } catch (err) {
      alert(err.message);
    }
  }

  async deleteDestination(id) {
    const ok = confirm('¿Deseas eliminar este destino del catálogo de ubicaciones?');
    if (!ok) return;
    try {
      await destinationService.deleteDestination(id);
      this.showToast('Destino eliminado del catálogo.');
      this.renderDestinations();
      this.populateSavedDestinationsSelect();
    } catch (err) {
      alert(err.message);
    }
  }

  // Llenar selector de destinos en el modal de nuevo encargo
  async populateSavedDestinationsSelect() {
    const select = document.getElementById('newOrderSavedDestSelect');
    if (!select) return;

    const destinations = await destinationService.getAllDestinations();
    let options = `<option value="">-- Cargar ubicación guardada o ingresar abajo --</option>`;
    destinations.forEach(d => {
      options += `<option value="${d.id}" data-city="${d.ciudad}" data-dir="${d.direccion || ''}" data-name="${d.nombre}" data-maps="${d.mapsUrl || ''}">${d.nombre} (${d.ciudad})</option>`;
    });
    select.innerHTML = options;
  }

  // ==========================================
  // MÓDULO: INVENTARIO & CATÁLOGO DE PRODUCTOS
  // ==========================================

  /**
   * Renderiza la vista de inventario con métricas, tarjetas o tabla según el modo activo
   */
  async renderInventory(searchQuery = null, categoryFilter = null, stockFilter = null) {
    const q = searchQuery !== null ? searchQuery : (document.getElementById('inventorySearchInput')?.value || '');
    const cat = categoryFilter !== null ? categoryFilter : (document.getElementById('inventoryCategoryFilter')?.value || 'all');
    const stockStatus = stockFilter !== null ? stockFilter : (document.getElementById('inventoryStockFilter')?.value || 'all');

    // 1. Poblar select de categorías dinámicamente si no está poblado o cambió
    await this.populateInventoryCategoriesFilter();

    // 2. Obtener productos filtrados
    const products = await productService.searchProducts(q, cat, stockStatus);

    // 3. Actualizar tarjetas KPI de métricas en la cabecera
    await this.renderInventoryMetrics();

    // 4. Actualizar badge numérico en la pestaña de navegación
    const allProducts = await productService.getAllProducts();
    const invBadge = document.getElementById('inventoryCountBadge');
    if (invBadge) invBadge.textContent = `${allProducts.length}`;

    // 5. Renderizar vista según modo activo (cards vs table)
    if (this.currentInventoryViewMode === 'table') {
      this.renderInventoryTable(products);
    } else {
      this.renderInventoryCards(products);
    }
  }

  /**
   * Llena el dropdown de categorías con las existentes en el catálogo
   */
  async populateInventoryCategoriesFilter() {
    const select = document.getElementById('inventoryCategoryFilter');
    if (!select) return;

    const currentVal = select.value || 'all';
    const categories = await productService.getCategories();

    let html = '<option value="all">Todas las categorías</option>';
    categories.forEach(c => {
      html += `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`;
    });

    select.innerHTML = html;
    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  }

  /**
   * Actualiza las 6 tarjetas de métricas del inventario
   */
  async renderInventoryMetrics() {
    const metrics = await productService.getInventoryMetrics();
    const currency = this.appConfig?.empresa?.moneda || '$';

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setEl('invMetricTotalProducts', `${metrics.totalProducts}`);
    setEl('invMetricTotalUnits', `${metrics.totalStock}`);
    setEl('invMetricCostValue', `${currency} ${metrics.totalCostValue.toFixed(2)}`);
    setEl('invMetricSaleValue', `${currency} ${metrics.totalSaleValue.toFixed(2)}`);
    setEl('invMetricGrossProfit', `${currency} ${metrics.projectedProfit.toFixed(2)}`);
    setEl('invMetricProfitMargin', `${metrics.profitMarginPercent.toFixed(1)}% margen bruto potencial`);
    setEl('invMetricAlerts', `${metrics.lowStockCount + metrics.outOfStockCount}`);
    setEl('invMetricAlertsHint', `${metrics.outOfStockCount} agotados / ${metrics.lowStockCount} con stock bajo`);
  }

  /**
   * Conmuta entre la vista de Tarjetas Visuales y Tabla Compacta
   */
  setInventoryViewMode(mode) {
    this.currentInventoryViewMode = mode;
    const btnCards = document.getElementById('btnInvViewCards');
    const btnTable = document.getElementById('btnInvViewTable');
    const cardsContainer = document.getElementById('inventoryCardsContainer');
    const tableContainer = document.getElementById('inventoryTableContainer');

    if (mode === 'table') {
      if (btnCards) btnCards.classList.remove('active');
      if (btnTable) btnTable.classList.add('active');
      if (cardsContainer) cardsContainer.style.display = 'none';
      if (tableContainer) tableContainer.style.display = 'block';
    } else {
      if (btnCards) btnCards.classList.add('active');
      if (btnTable) btnTable.classList.remove('active');
      if (cardsContainer) cardsContainer.style.display = 'grid';
      if (tableContainer) tableContainer.style.display = 'none';
    }

    this.renderInventory();
  }

  /**
   * Renderiza los productos en formato cuadrícula de tarjetas atractivas con fotos
   */
  renderInventoryCards(products) {
    const container = document.getElementById('inventoryCardsContainer');
    if (!container) return;

    if (!products || products.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3.5rem 1.5rem; background: var(--bg-secondary); border-radius: var(--radius-lg); border: 1px dashed var(--border-color);">
          <div style="font-size: 3rem; margin-bottom: 0.75rem;">📦</div>
          <h3 style="font-size: 1.2rem; font-weight: 700; color: var(--text-primary);">No se encontraron productos</h3>
          <p style="font-size: 0.875rem; color: var(--text-secondary); max-width: 420px; margin: 0.5rem auto 1.25rem auto;">
            No hay productos registrados con este criterio. Comienza a poblar tu catálogo con fotos por link para responder precios al instante.
          </p>
          <button type="button" class="btn btn-primary" onclick="window.app.openNewProductModal()">
            <span>➕</span> Agregar Primer Producto
          </button>
        </div>
      `;
      return;
    }

    const currency = this.appConfig?.empresa?.moneda || '$';
    const isAdmin = authService.isAdmin();

    container.innerHTML = products.map(p => {
      // Estado de stock
      let stockClass = 'in-stock';
      let stockText = `🟢 En Stock (${p.stock})`;
      if (p.stock <= 0) {
        stockClass = 'out-of-stock';
        stockText = '🔴 Agotado';
      } else if (p.stock <= (p.stockMinimo || 1)) {
        stockClass = 'low-stock';
        stockText = `🟡 Stock Bajo (${p.stock})`;
      }

      // Márgenes de ganancia
      const cost = p.precioCompra || 0;
      const retail = p.precioVenta || 0;
      const wholesale = p.precioMayor || 0;
      const marginRetailVal = Math.max(0, retail - cost);
      const marginRetailPct = cost > 0 ? ((marginRetailVal / cost) * 100).toFixed(0) : 0;

      // Imagen con fallback
      const hasImage = Boolean(p.imagenUrl && p.imagenUrl.trim());
      const imageHtml = hasImage
        ? `<img src="${this.escapeHtml(p.imagenUrl)}" alt="${this.escapeHtml(p.nombre)}" class="product-card-img" loading="lazy" onerror="window.app.onProductImageError(this)">
           <div class="product-card-img-placeholder" style="display: none;">
             <span>📦</span>
             <span>${this.escapeHtml(p.categoria || 'Producto')}</span>
           </div>`
        : `<div class="product-card-img-placeholder">
             <span>📦</span>
             <span>${this.escapeHtml(p.categoria || 'Sin Foto')}</span>
           </div>`;

      return `
        <div class="product-card">
          <div class="product-card-img-wrap">
            <span class="stock-pill product-card-badge-top-left ${stockClass}">${stockText}</span>
            <span class="meta-pill product-card-badge-top-right" style="background: rgba(15, 23, 42, 0.75); color: #ffffff; backdrop-filter: blur(8px);">
              ${this.escapeHtml(p.categoria || 'General')}
            </span>
            ${imageHtml}
          </div>

          <div class="product-card-content">
            <div class="product-card-meta">
              <span class="product-card-sku">SKU: ${this.escapeHtml(p.sku || 'S/N')}</span>
              <span style="font-size: 0.72rem; color: var(--text-muted);">${p.stock} unidades</span>
            </div>

            <h3 class="product-card-title">${this.escapeHtml(p.nombre)}</h3>

            ${p.descripcion ? `<p class="product-card-desc" title="${this.escapeHtml(p.descripcion)}">${this.escapeHtml(p.descripcion)}</p>` : '<div style="min-height: 1.5rem;"></div>'}

            ${p.ubicacion ? `<div class="product-card-location" title="Ubicación física en bodega/tienda">📍 ${this.escapeHtml(p.ubicacion)}</div>` : ''}

            <!-- Esquema de Precios -->
            <div class="product-card-prices-box">
              <div class="product-price-row">
                <span class="product-price-label">Precio al Detal (Venta):</span>
                <span class="product-price-val-retail">${currency} ${retail.toFixed(2)}</span>
              </div>
              <div class="product-price-row">
                <span class="product-price-label">Precio al Mayor:</span>
                <span class="product-price-val-wholesale">${currency} ${wholesale.toFixed(2)}</span>
              </div>
              ${isAdmin ? `
                <div class="product-price-row" style="border-top: 1px dashed var(--border-color); padding-top: 0.35rem; margin-top: 0.35rem;">
                  <span class="product-price-label">Costo de Compra:</span>
                  <span class="product-price-val-cost">${currency} ${cost.toFixed(2)}</span>
                </div>
                ${cost > 0 ? `
                  <div class="product-card-margin-tag">
                    Margen Detal: +${currency} ${marginRetailVal.toFixed(2)} (${marginRetailPct}%)
                  </div>
                ` : ''}
              ` : ''}
            </div>

            <!-- Botones de Acción -->
            <div class="product-card-actions">
              <button type="button" class="btn btn-secondary" onclick="window.app.copyProductQuoteWhatsApp('${p.id}')" title="Copiar cotización para WhatsApp">
                💬 Cotizar
              </button>
              <button type="button" class="btn btn-primary" onclick="window.app.loadProductIntoNewOrder('${p.id}', 'retail')" title="Cargar este producto a un nuevo encargo">
                ➕ A Encargo
              </button>
              <button type="button" class="btn btn-secondary" onclick="window.app.openStockAdjustModal('${p.id}')" title="Ajustar existencias de stock (+ / -)">
                📦 Stock
              </button>
              <button type="button" class="btn btn-secondary" onclick="window.app.openEditProductModal('${p.id}')" title="Editar producto">
                ✏️ Editar
              </button>
              ${isAdmin ? `
                <button type="button" class="btn btn-secondary btn-danger product-btn-full" onclick="window.app.deleteProduct('${p.id}')" style="margin-top: 0.2rem;" title="Eliminar producto del catálogo">
                  🗑️ Eliminar Producto
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Renderiza el catálogo en formato tabla compacta para inventario intensivo
   */
  renderInventoryTable(products) {
    const container = document.getElementById('inventoryTableContainer');
    if (!container) return;

    if (!products || products.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted);">
          No se encontraron productos en el inventario.
        </div>
      `;
      return;
    }

    const currency = this.appConfig?.empresa?.moneda || '$';
    const isAdmin = authService.isAdmin();

    container.innerHTML = `
      <table class="inv-table">
        <thead>
          <tr>
            <th style="width: 50px;">Foto</th>
            <th>Producto & SKU</th>
            <th>Categoría</th>
            <th>Ubicación</th>
            <th style="text-align: center;">Stock</th>
            ${isAdmin ? `<th style="text-align: right;">Costo Compra</th>` : ''}
            <th style="text-align: right;">Precio Venta</th>
            <th style="text-align: right;">Precio Mayor</th>
            <th style="text-align: center;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${products.map(p => {
            let stockBadge = `<span class="stock-pill in-stock">${p.stock}</span>`;
            if (p.stock <= 0) stockBadge = `<span class="stock-pill out-of-stock">0 (Agotado)</span>`;
            else if (p.stock <= (p.stockMinimo || 1)) stockBadge = `<span class="stock-pill low-stock">${p.stock} (Bajo)</span>`;

            const imgHtml = p.imagenUrl 
              ? `<img src="${this.escapeHtml(p.imagenUrl)}" class="inv-thumb-img" alt="${this.escapeHtml(p.nombre)}" onerror="this.src=''; this.parentElement.innerHTML='📦';">`
              : `<span style="font-size: 1.4rem;">📦</span>`;

            return `
              <tr>
                <td style="text-align: center;">${imgHtml}</td>
                <td>
                  <strong>${this.escapeHtml(p.nombre)}</strong>
                  <div style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">
                    SKU: ${this.escapeHtml(p.sku || 'S/N')}
                  </div>
                </td>
                <td><span class="meta-pill">${this.escapeHtml(p.categoria || 'General')}</span></td>
                <td><span style="font-size: 0.8rem; color: var(--text-secondary);">${this.escapeHtml(p.ubicacion || '—')}</span></td>
                <td style="text-align: center;">${stockBadge}</td>
                ${isAdmin ? `<td style="text-align: right; font-family: var(--font-mono);">${currency} ${(p.precioCompra || 0).toFixed(2)}</td>` : ''}
                <td style="text-align: right; font-weight: 700; color: var(--color-success); font-family: var(--font-mono);">${currency} ${(p.precioVenta || 0).toFixed(2)}</td>
                <td style="text-align: right; font-weight: 700; color: var(--brand-primary); font-family: var(--font-mono);">${currency} ${(p.precioMayor || 0).toFixed(2)}</td>
                <td style="text-align: center; white-space: nowrap;">
                  <button type="button" class="btn btn-secondary btn-icon" title="Copiar Cotización WhatsApp" onclick="window.app.copyProductQuoteWhatsApp('${p.id}')">💬</button>
                  <button type="button" class="btn btn-primary btn-icon" title="Cargar al Encargo" onclick="window.app.loadProductIntoNewOrder('${p.id}', 'retail')">➕</button>
                  <button type="button" class="btn btn-secondary btn-icon" title="Ajustar Stock" onclick="window.app.openStockAdjustModal('${p.id}')">📦</button>
                  <button type="button" class="btn btn-secondary btn-icon" title="Editar" onclick="window.app.openEditProductModal('${p.id}')">✏️</button>
                  ${isAdmin ? `<button type="button" class="btn btn-secondary btn-icon btn-danger" title="Eliminar" onclick="window.app.deleteProduct('${p.id}')">🗑️</button>` : ''}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  /**
   * Abre modal para crear un nuevo producto
   */
  openNewProductModal() {
    document.getElementById('productModalTitle').textContent = '🏷️ Registrar Nuevo Producto';
    document.getElementById('prodEditId').value = '';
    document.getElementById('prodNombreInput').value = '';
    document.getElementById('prodSkuInput').value = this.generateSkuString();
    document.getElementById('prodCategoriaInput').value = '';
    document.getElementById('prodUbicacionInput').value = '';
    document.getElementById('prodImagenUrlInput').value = '';
    document.getElementById('prodPrecioCompraInput').value = '';
    document.getElementById('prodPrecioVentaInput').value = '';
    document.getElementById('prodPrecioMayorInput').value = '';
    document.getElementById('prodStockInput').value = '1';
    document.getElementById('prodStockMinimoInput').value = '2';
    document.getElementById('prodDescripcionInput').value = '';
    document.getElementById('prodNotasInput').value = '';

    this.updateProductImagePreview();
    this.calculateProductMarginPreview();
    this.openModal('productModal');
  }

  /**
   * Abre modal para editar un producto existente
   */
  async openEditProductModal(id) {
    const p = await productService.getProductById(id);
    if (!p) {
      alert('Producto no encontrado');
      return;
    }

    document.getElementById('productModalTitle').textContent = '✏️ Editar Producto';
    document.getElementById('prodEditId').value = p.id;
    document.getElementById('prodNombreInput').value = p.nombre || '';
    document.getElementById('prodSkuInput').value = p.sku || '';
    document.getElementById('prodCategoriaInput').value = p.categoria || '';
    document.getElementById('prodUbicacionInput').value = p.ubicacion || '';
    document.getElementById('prodImagenUrlInput').value = p.imagenUrl || '';
    document.getElementById('prodPrecioCompraInput').value = p.precioCompra !== undefined ? p.precioCompra : '';
    document.getElementById('prodPrecioVentaInput').value = p.precioVenta !== undefined ? p.precioVenta : '';
    document.getElementById('prodPrecioMayorInput').value = p.precioMayor !== undefined ? p.precioMayor : '';
    document.getElementById('prodStockInput').value = p.stock !== undefined ? p.stock : 0;
    document.getElementById('prodStockMinimoInput').value = p.stockMinimo !== undefined ? p.stockMinimo : 2;
    document.getElementById('prodDescripcionInput').value = p.descripcion || '';
    document.getElementById('prodNotasInput').value = p.notas || '';

    this.updateProductImagePreview();
    this.calculateProductMarginPreview();
    this.openModal('productModal');
  }

  /**
   * Actualiza la previsualización en vivo de la imagen del producto
   */
  updateProductImagePreview() {
    const urlInput = document.getElementById('prodImagenUrlInput');
    const imgEl = document.getElementById('prodImagePreview');
    const placeholder = document.getElementById('prodImagePlaceholder');
    const url = urlInput ? urlInput.value.trim() : '';

    if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/'))) {
      if (imgEl) {
        imgEl.src = url;
        imgEl.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
    } else {
      if (imgEl) {
        imgEl.src = '';
        imgEl.style.display = 'none';
      }
      if (placeholder) {
        placeholder.style.display = 'flex';
        placeholder.innerHTML = `<span style="font-size: 1.5rem;">🖼️</span>`;
      }
    }
  }

  /**
   * Manejador de error si la imagen por link falla al cargar
   */
  onProductImageError(imgEl) {
    if (!imgEl) return;
    imgEl.style.display = 'none';
    const placeholder = imgEl.parentElement?.querySelector('.prod-image-placeholder') || 
                        imgEl.parentElement?.querySelector('.prod-image-placeholder-thumb') || 
                        imgEl.parentElement?.querySelector('.product-card-img-placeholder');
    if (placeholder) {
      placeholder.style.display = 'flex';
      placeholder.innerHTML = `<span style="font-size: 1.3rem;" title="Enlace roto o imagen no disponible">⚠️</span>`;
    }
  }

  /**
   * Calcula el margen de ganancia en vivo mientras se escriben los precios
   */
  calculateProductMarginPreview() {
    const cost = Number(document.getElementById('prodPrecioCompraInput')?.value) || 0;
    const retail = Number(document.getElementById('prodPrecioVentaInput')?.value) || 0;
    const wholesale = Number(document.getElementById('prodPrecioMayorInput')?.value) || 0;
    const currency = this.appConfig?.empresa?.moneda || '$';

    const detalMargin = Math.max(0, retail - cost);
    const detalPct = cost > 0 ? ((detalMargin / cost) * 100).toFixed(0) : 0;

    const mayorMargin = Math.max(0, wholesale - cost);
    const mayorPct = cost > 0 ? ((mayorMargin / cost) * 100).toFixed(0) : 0;

    const detalEl = document.getElementById('marginDetalPreview');
    if (detalEl) {
      detalEl.textContent = `${currency} ${detalMargin.toFixed(2)} (${detalPct}%)`;
      detalEl.style.color = detalMargin > 0 ? 'var(--color-success)' : 'var(--text-muted)';
    }

    const mayorEl = document.getElementById('marginMayorPreview');
    if (mayorEl) {
      mayorEl.textContent = `${currency} ${mayorMargin.toFixed(2)} (${mayorPct}%)`;
      mayorEl.style.color = mayorMargin > 0 ? 'var(--brand-primary)' : 'var(--text-muted)';
    }
  }

  /**
   * Generador de SKU aleatorio
   */
  generateSkuString() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 3; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
    code += '-' + Math.floor(100 + Math.random() * 900);
    return code;
  }

  generateRandomSku() {
    const input = document.getElementById('prodSkuInput');
    if (input) input.value = this.generateSkuString();
  }

  /**
   * Guarda o actualiza un producto desde el formulario del modal
   */
  async submitProductForm() {
    const id = document.getElementById('prodEditId').value;
    const nombre = document.getElementById('prodNombreInput').value.trim();
    if (!nombre) {
      alert('El nombre del producto es obligatorio.');
      return;
    }

    const sku = document.getElementById('prodSkuInput').value.trim();
    const categoria = document.getElementById('prodCategoriaInput').value.trim() || 'General';
    const ubicacion = document.getElementById('prodUbicacionInput').value.trim();
    const imagenUrl = document.getElementById('prodImagenUrlInput').value.trim();
    const precioCompra = Number(document.getElementById('prodPrecioCompraInput').value) || 0;
    const precioVenta = Number(document.getElementById('prodPrecioVentaInput').value) || 0;
    const precioMayor = Number(document.getElementById('prodPrecioMayorInput').value) || 0;
    const stock = Number(document.getElementById('prodStockInput').value) || 0;
    const stockMinimo = Number(document.getElementById('prodStockMinimoInput').value) || 1;
    const descripcion = document.getElementById('prodDescripcionInput').value.trim();
    const notas = document.getElementById('prodNotasInput').value.trim();

    try {
      const saved = await productService.saveProduct({
        id: id || undefined,
        nombre,
        sku,
        categoria,
        ubicacion,
        imagenUrl,
        precioCompra,
        precioVenta,
        precioMayor,
        stock,
        stockMinimo,
        descripcion,
        notas
      });

      this.closeModal('productModal');
      this.showToast(`Producto "${saved.nombre}" guardado con éxito.`);
      this.renderInventory();
      this.updateGlobalBadgeMetrics();
    } catch (err) {
      alert('Error al guardar producto: ' + err.message);
    }
  }

  /**
   * Elimina un producto del catálogo e inventario
   */
  async deleteProduct(id) {
    const p = await productService.getProductById(id);
    if (!p) return;

    const ok = confirm(`¿Estás seguro de eliminar "${p.nombre}" del catálogo?`);
    if (!ok) return;

    try {
      await productService.deleteProduct(id);
      this.showToast(`Producto "${p.nombre}" eliminado.`);
      this.renderInventory();
      this.updateGlobalBadgeMetrics();
    } catch (err) {
      alert('Error al eliminar producto: ' + err.message);
    }
  }

  /**
   * Modal de Ajuste de Stock
   */
  async openStockAdjustModal(id) {
    const p = await productService.getProductById(id);
    if (!p) return;

    this.selectedProductForAdjust = p;
    document.getElementById('stockAdjustProdId').value = p.id;
    document.getElementById('stockAdjustProdName').textContent = p.nombre;
    document.getElementById('stockAdjustProdCurrent').textContent = `${p.stock} unidades`;
    document.getElementById('stockAdjustQuantityInput').value = '1';

    this.setStockAdjustMode('add');
    this.openModal('stockAdjustModal');
  }

  setStockAdjustMode(mode) {
    this.currentStockAdjustMode = mode;
    const btnAdd = document.getElementById('btnStockModeAdd');
    const btnSub = document.getElementById('btnStockModeSubtract');
    const btnSet = document.getElementById('btnStockModeSet');
    const label = document.getElementById('stockAdjustAmountLabel');

    if (btnAdd) btnAdd.classList.toggle('active', mode === 'add');
    if (btnSub) btnSub.classList.toggle('active', mode === 'sub');
    if (btnSet) btnSet.classList.toggle('active', mode === 'set');

    if (mode === 'add') {
      if (label) label.textContent = 'Cantidad de Unidades a Añadir (+):';
    } else if (mode === 'sub') {
      if (label) label.textContent = 'Cantidad de Unidades a Retirar (-):';
    } else {
      if (label) label.textContent = 'Fijar Cantidad Total Exacta (=):';
      if (this.selectedProductForAdjust) {
        document.getElementById('stockAdjustQuantityInput').value = this.selectedProductForAdjust.stock;
      }
    }
  }

  async submitStockAdjustment() {
    const id = document.getElementById('stockAdjustProdId').value;
    const qty = parseInt(document.getElementById('stockAdjustQuantityInput').value, 10) || 0;
    const reason = document.getElementById('stockAdjustReasonSelect').value;

    try {
      let updated;
      if (this.currentStockAdjustMode === 'set') {
        updated = await productService.adjustStock(id, qty, 'absolute');
      } else if (this.currentStockAdjustMode === 'sub') {
        updated = await productService.adjustStock(id, -qty, 'delta');
      } else {
        updated = await productService.adjustStock(id, qty, 'delta');
      }

      this.closeModal('stockAdjustModal');
      this.showToast(`Stock de "${updated.nombre}" actualizado a ${updated.stock} unidades.`);
      this.renderInventory();
      this.updateGlobalBadgeMetrics();
    } catch (err) {
      alert('Error al ajustar stock: ' + err.message);
    }
  }

  /**
   * Modal de Consultor Rápido de Precios y Cotizaciones WhatsApp
   */
  openPriceCheckerModal() {
    const input = document.getElementById('priceCheckerSearchInput');
    if (input) input.value = '';
    this.renderPriceCheckerResults('');
    this.openModal('priceCheckerModal');
    setTimeout(() => {
      input?.focus();
    }, 200);
  }

  async renderPriceCheckerResults(query = '') {
    const container = document.getElementById('priceCheckerResultsList');
    if (!container) return;

    const products = await productService.searchProducts(query, 'all', 'all');
    const currency = this.appConfig?.empresa?.moneda || '$';
    const isAdmin = authService.isAdmin();

    if (!products || products.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem 1rem; color: var(--text-muted);">
          No se encontraron productos para "${this.escapeHtml(query)}".
        </div>
      `;
      return;
    }

    container.innerHTML = products.map(p => {
      let stockPill = `<span class="stock-pill in-stock">🟢 ${p.stock} disponibles</span>`;
      if (p.stock <= 0) stockPill = `<span class="stock-pill out-of-stock">🔴 Agotado</span>`;
      else if (p.stock <= (p.stockMinimo || 1)) stockPill = `<span class="stock-pill low-stock">🟡 ${p.stock} disp. (Bajo)</span>`;

      const thumbHtml = p.imagenUrl
        ? `<img src="${this.escapeHtml(p.imagenUrl)}" class="price-checker-thumb" alt="${this.escapeHtml(p.nombre)}" onerror="this.src=''; this.parentElement.innerHTML='📦';">`
        : `<div class="price-checker-thumb">📦</div>`;

      return `
        <div class="price-checker-item-card">
          ${thumbHtml}
          <div class="price-checker-info">
            <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              <strong style="font-size: 1rem; color: var(--text-primary);">${this.escapeHtml(p.nombre)}</strong>
              ${stockPill}
            </div>

            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem;">
              SKU: <code>${this.escapeHtml(p.sku || 'S/N')}</code> &bull; Categoría: ${this.escapeHtml(p.categoria || 'General')}
              ${p.ubicacion ? ` &bull; 📍 Ubicación: <strong>${this.escapeHtml(p.ubicacion)}</strong>` : ''}
            </div>

            <div class="price-checker-prices">
              <div>
                <span style="font-size: 0.75rem; color: var(--text-muted); display: block;">Precio al Detal (Venta):</span>
                <span style="font-size: 1.3rem; font-weight: 800; color: var(--color-success); font-family: var(--font-mono);">${currency} ${(p.precioVenta || 0).toFixed(2)}</span>
              </div>
              <div>
                <span style="font-size: 0.75rem; color: var(--text-muted); display: block;">Precio al Mayor:</span>
                <span style="font-size: 1.1rem; font-weight: 700; color: var(--brand-primary); font-family: var(--font-mono);">${currency} ${(p.precioMayor || 0).toFixed(2)}</span>
              </div>
              ${isAdmin && p.precioCompra ? `
                <div>
                  <span style="font-size: 0.75rem; color: var(--text-muted); display: block;">Costo Compra:</span>
                  <span style="font-size: 0.95rem; font-family: var(--font-mono); color: var(--text-secondary);">${currency} ${p.precioCompra.toFixed(2)}</span>
                </div>
              ` : ''}
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: 0.4rem; flex-shrink: 0;">
            <button type="button" class="btn btn-secondary" onclick="window.app.copyProductQuoteWhatsApp('${p.id}')" title="Copiar cotización para WhatsApp">
              📲 Copiar WhatsApp
            </button>
            <button type="button" class="btn btn-primary" onclick="window.app.loadProductIntoNewOrder('${p.id}', 'retail')" title="Cargar a un nuevo encargo">
              ➕ A Encargo
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Copia el texto formateado de cotización de un producto para WhatsApp
   */
  async copyProductQuoteWhatsApp(productId) {
    const p = await productService.getProductById(productId);
    if (!p) return;

    const currency = this.appConfig?.empresa?.moneda || '$';
    const company = this.appConfig?.empresa?.nombre || 'Encargos & Apartados Express';
    const quote = productService.formatWhatsAppQuote(p, currency, company);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(quote).then(() => {
        this.showToast(`📋 ¡Cotización de "${p.nombre}" copiada al portapapeles! Lista para pegar en WhatsApp.`, 'success');
      }).catch(() => {
        prompt('Copia esta cotización para tu cliente:', quote);
      });
    } else {
      prompt('Copia esta cotización para tu cliente:', quote);
    }
  }

  /**
   * Carga directamente un producto del inventario dentro del Modal de Nuevo Encargo
   */
  async loadProductIntoNewOrder(productId, priceType = 'retail') {
    const p = await productService.getProductById(productId);
    if (!p) return;

    // Cerrar modales abiertos si los hay
    this.closeModal('priceCheckerModal');
    this.closeModal('catalogOrderPickerModal');

    // Abrir modal de nuevo encargo si no está abierto
    const newOrderModal = document.getElementById('newOrderModal');
    if (!newOrderModal || newOrderModal.style.display !== 'flex') {
      await this.openNewOrderModal();
    }

    const price = priceType === 'wholesale' ? (p.precioMayor || p.precioVenta || 0) : (p.precioVenta || 0);

    // Si la primera fila está vacía, reemplazarla; si no, añadir nueva fila
    const firstRow = document.querySelector('#newOrderItemsRows .item-input-row');
    const firstDesc = firstRow?.querySelector('.item-desc')?.value.trim();
    if (firstRow && !firstDesc) {
      firstRow.querySelector('.item-desc').value = p.nombre;
      firstRow.querySelector('.item-qty').value = '1';
      firstRow.querySelector('.item-price').value = price;
      let hiddenId = firstRow.querySelector('.item-prod-id');
      if (!hiddenId) {
        hiddenId = document.createElement('input');
        hiddenId.type = 'hidden';
        hiddenId.className = 'item-prod-id';
        firstRow.prepend(hiddenId);
      }
      hiddenId.value = p.id;
    } else {
      this.addNewItemRow({
        productoId: p.id,
        nombre: p.nombre,
        descripcion: p.nombre,
        cantidad: 1,
        precioUnitario: price
      });
    }

    this.calculateNewOrderTotals();
    this.showToast(`🏷️ "${p.nombre}" cargado con precio de ${priceType === 'wholesale' ? 'Mayoreo' : 'Detal'}.`);
  }

  /**
   * Modal Selector de Catálogo para Encargos
   */
  async openCatalogPickerForOrder() {
    const input = document.getElementById('catalogPickerSearchInput');
    if (input) input.value = '';
    await this.renderCatalogOrderPickerList('');
    this.openModal('catalogOrderPickerModal');
    setTimeout(() => {
      input?.focus();
    }, 200);
  }

  async renderCatalogOrderPickerList(query = '') {
    const container = document.getElementById('catalogOrderPickerList');
    if (!container) return;

    const products = await productService.searchProducts(query, 'all', 'all');
    const currency = this.appConfig?.empresa?.moneda || '$';

    if (!products || products.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem 1rem; color: var(--text-muted);">
          No se encontraron productos en el catálogo.
        </div>
      `;
      return;
    }

    container.innerHTML = products.map(p => {
      let stockPill = `<span class="stock-pill in-stock">${p.stock} disp.</span>`;
      if (p.stock <= 0) stockPill = `<span class="stock-pill out-of-stock">Agotado</span>`;

      return `
        <div class="catalog-picker-item">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              <strong style="color: var(--text-primary);">${this.escapeHtml(p.nombre)}</strong>
              ${stockPill}
            </div>
            <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 0.2rem;">
              SKU: ${this.escapeHtml(p.sku || 'S/N')} &bull; Categoría: ${this.escapeHtml(p.categoria || 'General')}
              ${p.ubicacion ? ` &bull; 📍 ${this.escapeHtml(p.ubicacion)}` : ''}
            </div>
            <div style="font-size: 0.85rem; margin-top: 0.35rem;">
              Detal: <strong style="color: var(--color-success); font-family: var(--font-mono);">${currency} ${(p.precioVenta || 0).toFixed(2)}</strong> &bull; 
              Mayor: <strong style="color: var(--brand-primary); font-family: var(--font-mono);">${currency} ${(p.precioMayor || 0).toFixed(2)}</strong>
            </div>
          </div>

          <div class="catalog-picker-actions">
            <button type="button" class="btn btn-secondary" onclick="window.app.loadProductIntoNewOrder('${p.id}', 'wholesale')" title="Cargar con precio al mayor">
              Mayor (${currency}${p.precioMayor})
            </button>
            <button type="button" class="btn btn-primary" onclick="window.app.loadProductIntoNewOrder('${p.id}', 'retail')" title="Cargar con precio al detal">
              Detal (${currency}${p.precioVenta})
            </button>
          </div>
        </div>
      `;
    }).join('');
  }


  // ==========================================
  // AUTENTICACIÓN, SESIÓN & CONTROL DE ROLES
  // ==========================================
  checkAuthenticationState() {
    const isAuth = authService.isAuthenticated();
    const loginOverlay = document.getElementById('appLoginOverlay');
    const isSupabaseConfigured = !!(this.appConfig?.cloud?.supabaseUrl && this.appConfig?.cloud?.supabaseAnonKey);
    const tabsNav = document.getElementById('loginTabsNav');
    const unlockWrapper = document.getElementById('loginAdminUnlockWrapper');

    if (!isAuth) {
      if (loginOverlay) {
        loginOverlay.style.display = 'flex';
      }
      // Si la aplicación se abre en blanco por primera vez sin Supabase configurado, activar Supabase directamente
      if (!isSupabaseConfigured) {
        if (tabsNav) tabsNav.style.display = 'flex';
        if (unlockWrapper) unlockWrapper.style.display = 'none';
        this.switchLoginMode('supabase', false);
      } else {
        // Si ya está configurado (ej. teléfono de un despachador): mostrar solo el formulario limpio de login
        if (tabsNav) tabsNav.style.display = 'none';
        if (unlockWrapper) unlockWrapper.style.display = 'block';
        this.clearSupabaseLoginInputs();
        this.switchLoginMode('login');
      }
      this.updateNavSessionUI();
      return false;
    }

    if (loginOverlay) {
      loginOverlay.style.display = 'none';
    }
    this.updateNavSessionUI();
    this.applyRolePermissions();
    return true;
  }

  updateNavSessionUI() {
    const user = authService.getCurrentUser();
    const sessionContainer = document.getElementById('navUserSession');
    const avatarEl = document.getElementById('navUserAvatar');
    const nameEl = document.getElementById('navUserName');
    const roleEl = document.getElementById('navUserRoleTag');
    const toggleBtn = document.getElementById('btnToggleDispatcherMode');
    const logoutBtn = document.getElementById('btnNavLogout');

    if (!user) {
      if (sessionContainer) sessionContainer.style.display = 'none';
      return;
    }

    const isSimulated = authService.isSimulatedDispatcher();

    // Actualizar nombre y cargo debajo de Encargos & Apartados
    const brandUserBox = document.getElementById('brandUserOperating');
    const brandNameEl = document.getElementById('brandUserName');
    const brandRoleEl = document.getElementById('brandUserRoleBadge');

    if (brandUserBox) brandUserBox.style.display = 'flex';
    if (brandNameEl) brandNameEl.textContent = user.nombre || user.usuario || 'Operando';
    if (brandRoleEl) {
      if (isSimulated) {
        brandRoleEl.textContent = '🚚 Modo Ruta';
        brandRoleEl.className = 'brand-user-role-badge dispatcher';
      } else if (user.rol === 'admin') {
        brandRoleEl.textContent = '👑 Administrador';
        brandRoleEl.className = 'brand-user-role-badge admin';
      } else {
        brandRoleEl.textContent = '🚚 Despachador';
        brandRoleEl.className = 'brand-user-role-badge dispatcher';
      }
    }

    if (avatarEl) avatarEl.textContent = isSimulated ? '🚚' : (user.avatar || (user.rol === 'admin' ? '👑' : '🚚'));
    if (nameEl) nameEl.textContent = user.nombre;

    if (roleEl) {
      if (isSimulated) {
        roleEl.textContent = 'En Modo Ruta (Despacho)';
        roleEl.style.color = '#38bdf8';
      } else {
        roleEl.textContent = user.cargoTitulo || (user.rol === 'admin' ? 'Administrador General' : 'Despachador');
        roleEl.style.color = '';
      }
    }

    if (toggleBtn) {
      // Solo el Administrador puede alternar modo ruta / despachador
      if (user.rol === 'admin') {
        toggleBtn.style.display = 'inline-flex';
        if (isSimulated) {
          toggleBtn.innerHTML = '👑 Modo Administrador';
          toggleBtn.className = 'btn-mode-toggle btn-mode-admin';
          toggleBtn.title = 'Actualmente en Modo Ruta. Haz clic para volver al Modo Administrador con acceso total';
        } else {
          toggleBtn.innerHTML = '🚚 Modo Ruta';
          toggleBtn.className = 'btn-mode-toggle btn-mode-dispatcher';
          toggleBtn.title = 'Actualmente en Modo Administrador. Haz clic para cambiar a Modo Ruta (Vista de Despachador)';
        }
      } else {
        // Al despachador real le queda totalmente oculto
        toggleBtn.style.display = 'none';
      }
    }

    if (logoutBtn) {
      logoutBtn.style.display = 'inline-flex';
    }
  }

  applyRolePermissions() {
    const isAdmin = authService.isAdmin();
    const isDispatcher = authService.isDispatcher();
    const current = authService.getCurrentUser();

    // Pestañas de navegación
    const tabDashboard = document.getElementById('navTabDashboard');
    const tabSearch = document.getElementById('navTabSearch');
    const tabOrders = document.getElementById('navTabOrders');
    const tabDestinations = document.getElementById('navTabDestinations');
    const tabInventory = document.getElementById('navTabInventory');
    const tabCustomers = document.getElementById('navTabCustomers');
    const tabSettings = document.getElementById('navTabSettings');

    // Segmentos de la vista de pedidos
    const tabGroupFinalized = document.getElementById('tabGroupFinalized');
    const tabGroupAll = document.getElementById('tabGroupAll');

    if (isAdmin) {
      // 👑 ADMINISTRADOR: Acceso total a todas las interfaces
      if (tabDashboard) tabDashboard.style.display = 'flex';
      if (tabSearch) tabSearch.style.display = 'flex';
      if (tabOrders) tabOrders.style.display = 'flex';
      if (tabDestinations) tabDestinations.style.display = 'flex';
      if (tabInventory) tabInventory.style.display = 'flex';
      if (tabCustomers) tabCustomers.style.display = 'flex';
      if (tabSettings) tabSettings.style.display = 'flex';
      if (tabGroupFinalized) tabGroupFinalized.style.display = 'inline-flex';
      if (tabGroupAll) tabGroupAll.style.display = 'inline-flex';
    } else {
      // 🚚 DESPACHADOR: Solo le atañe el modo despachador y pedidos activos
      // Ocultar configuración, panel de finanzas y CRM de clientes
      if (tabDashboard) tabDashboard.style.display = 'none';
      if (tabCustomers) tabCustomers.style.display = 'none';
      if (tabSettings) tabSettings.style.display = 'none';
      if (tabInventory) tabInventory.style.display = 'none'; // Reservado para Modo Administrador

      // Despachador opera exclusivamente en encargos activos (ocultar historial y archivo)
      if (tabGroupFinalized) tabGroupFinalized.style.display = 'none';
      if (tabGroupAll) tabGroupAll.style.display = 'none';
      this.currentOrderGroup = 'activos';

      // Mantener operativas las vistas de logística:
      if (tabOrders) tabOrders.style.display = 'flex';
      if (tabSearch) tabSearch.style.display = 'flex';
      if (tabDestinations) tabDestinations.style.display = 'flex';
    }

    const brandTag = document.querySelector('.brand-tag');
    if (brandTag && current) {
      if (authService.isSimulatedDispatcher()) {
        brandTag.textContent = `v1.8.2 (Modo Ruta / Despacho)`;
      } else if (isAdmin) {
        brandTag.textContent = `v1.8.2 (Administrador)`;
      } else {
        brandTag.textContent = `v1.8.2 (Despachador)`;
      }
    }
  }

  async handleLoginSubmit() {
    const userInput = document.getElementById('loginUsernameInput');
    const passInput = document.getElementById('loginPasswordInput');
    const alertBox = document.getElementById('loginAlertBox');
    const btn = document.getElementById('btnLoginSubmit');

    const username = userInput ? userInput.value.trim() : '';
    const password = passInput ? passInput.value.trim() : '';

    if (!username || !password) {
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.className = 'login-alert error';
        alertBox.textContent = 'Por favor ingresa tu usuario y contraseña.';
      }
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Verificando...';
    }

    try {
      const res = await authService.login(username, password);
      if (!res.success) {
        if (alertBox) {
          alertBox.style.display = 'block';
          alertBox.className = 'login-alert error';
          alertBox.textContent = `❌ ${res.message}`;
        }
        return;
      }

      if (alertBox) alertBox.style.display = 'none';
      if (userInput) userInput.value = '';
      if (passInput) passInput.value = '';

      this.checkAuthenticationState();
      this.showToast(`¡Bienvenido/a, ${res.user.nombre}!`, 'success');

      if (authService.isDispatcher()) {
        this.switchView('orders');
      } else {
        this.switchView('dashboard');
      }
      this.updateGlobalBadgeMetrics();
    } catch (err) {
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.className = 'login-alert error';
        alertBox.textContent = `❌ Error al iniciar sesión: ${err.message}`;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Iniciar Sesión';
      }
    }
  }

  handleNavLogout() {
    authService.logout();
    this.showToast('Sesión cerrada correctamente.', 'info');
    this.checkAuthenticationState();
  }

  handleToggleDispatcherMode() {
    const isNowSimulated = authService.toggleAdminDispatcherSimulation();
    this.updateNavSessionUI();
    this.applyRolePermissions();

    if (isNowSimulated) {
      this.showToast('🚚 Modo Ruta activado: Operando como despachador.', 'info');
      this.switchView('orders');
    } else {
      this.showToast('👑 Modo Administrador restaurado: Acceso total desbloqueado.', 'success');
      this.switchView('dashboard');
    }
    this.updateGlobalBadgeMetrics();
  }

  clearSupabaseLoginInputs() {
    const urlInput = document.getElementById('initSupabaseUrl');
    const keyInput = document.getElementById('initSupabaseKey');
    if (urlInput) urlInput.value = '';
    if (keyInput) keyInput.value = '';
  }

  async handleAdminUnlockSubmit() {
    const passInput = document.getElementById('adminUnlockPasswordInput');
    const alertBox = document.getElementById('adminUnlockAlert');
    const btn = document.getElementById('btnAdminUnlockSubmit');
    const password = passInput ? passInput.value.trim() : '';

    if (!password) {
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.className = 'login-alert error';
        alertBox.textContent = 'Por favor ingresa la contraseña de Administrador.';
      }
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Verificando...';
    }

    try {
      const isValid = await authService.verifyAdminPassword(password);
      if (!isValid) {
        if (alertBox) {
          alertBox.style.display = 'block';
          alertBox.className = 'login-alert error';
          alertBox.textContent = '❌ Contraseña de Administrador incorrecta.';
        }
        return;
      }

      // Desbloqueo exitoso
      this.showToast('🔓 Acceso de Administrador verificado.', 'success');

      // Mostrar pestañas y desbloquear formulario de Supabase con credenciales precargadas
      const tabsNav = document.getElementById('loginTabsNav');
      if (tabsNav) tabsNav.style.display = 'flex';
      this.switchLoginMode('supabase', true);
    } catch (err) {
      if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.className = 'login-alert error';
        alertBox.textContent = `❌ Error: ${err.message}`;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔓 Desbloquear Supabase';
      }
    }
  }

  switchLoginMode(mode = 'login', allowPreload = false) {
    const now = Date.now();
    if (this._lastModeSwitchTime && (now - this._lastModeSwitchTime) < 350) {
      return;
    }
    this._lastModeSwitchTime = now;

    const loginPanel = document.getElementById('loginFormTabPanel');
    const verifyPanel = document.getElementById('adminVerifyTabPanel');
    const supabaseBox = document.getElementById('initialSupabaseSetupBox');
    const tabLogin = document.getElementById('tabBtnLogin');
    const tabSupabase = document.getElementById('tabBtnSupabase');
    const tabsNav = document.getElementById('loginTabsNav');
    const isSupabaseConfigured = !!(this.appConfig?.cloud?.supabaseUrl && this.appConfig?.cloud?.supabaseAnonKey);

    if (mode === 'admin-verify') {
      if (loginPanel) loginPanel.style.display = 'none';
      if (supabaseBox) supabaseBox.style.display = 'none';
      if (verifyPanel) verifyPanel.style.display = 'block';
      if (tabsNav) tabsNav.style.display = 'none';
      const passInp = document.getElementById('adminUnlockPasswordInput');
      const alertBox = document.getElementById('adminUnlockAlert');
      if (passInp) {
        passInp.value = '';
        setTimeout(() => passInp.focus(), 150);
      }
      if (alertBox) alertBox.style.display = 'none';
      return;
    }

    if (mode === 'supabase') {
      if (loginPanel) loginPanel.style.display = 'none';
      if (verifyPanel) verifyPanel.style.display = 'none';
      if (supabaseBox) supabaseBox.style.display = 'block';
      if (tabLogin) {
        tabLogin.classList.remove('active');
        tabLogin.setAttribute('aria-selected', 'false');
      }
      if (tabSupabase) {
        tabSupabase.classList.add('active');
        tabSupabase.setAttribute('aria-selected', 'true');
      }

      // Solo precargar credenciales si es primera vez o si fue desbloqueado explícitamente por el admin
      const urlInput = document.getElementById('initSupabaseUrl');
      const keyInput = document.getElementById('initSupabaseKey');
      if (allowPreload || !isSupabaseConfigured) {
        if (urlInput && !urlInput.value && this.appConfig?.cloud?.supabaseUrl) {
          urlInput.value = this.appConfig.cloud.supabaseUrl;
        }
        if (keyInput && !keyInput.value && this.appConfig?.cloud?.supabaseAnonKey) {
          keyInput.value = this.appConfig.cloud.supabaseAnonKey;
        }
      }

      // Enfocar suavemente el primer campo de Supabase
      setTimeout(() => {
        if (urlInput && document.activeElement !== urlInput && !keyInput?.value) {
          urlInput.focus({ preventScroll: true });
        }
      }, 150);
    } else {
      // mode === 'login'
      if (verifyPanel) verifyPanel.style.display = 'none';
      if (supabaseBox) supabaseBox.style.display = 'none';
      if (loginPanel) loginPanel.style.display = 'block';
      if (tabLogin) {
        tabLogin.classList.add('active');
        tabLogin.setAttribute('aria-selected', 'true');
      }
      if (tabSupabase) {
        tabSupabase.classList.remove('active');
        tabSupabase.setAttribute('aria-selected', 'false');
      }

      // Si Supabase ya está configurado y el admin vuelve al login, ocultar pestañas para el despachador
      if (isSupabaseConfigured && !allowPreload) {
        if (tabsNav) tabsNav.style.display = 'none';
        this.clearSupabaseLoginInputs();
      }
    }
  }

  togglePasswordVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      if (btn) btn.textContent = '🙈';
    } else {
      input.type = 'password';
      if (btn) btn.textContent = '👁️';
    }
  }

  async pasteToInput(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          input.value = text.trim();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          this.showToast('📋 Pegado desde portapapeles', 'info');
          return;
        }
      }
    } catch (err) {
      console.warn('Clipboard read failed:', err);
    }
    input.focus();
    input.select();
  }

  toggleLoginCompactMode() {
    const card = document.querySelector('.login-card-container');
    const btn = document.getElementById('btnToggleLoginCompact');
    if (!card) return;
    const isCompact = card.classList.toggle('is-compact');
    if (btn) {
      btn.textContent = isCompact ? '↕️ Expandir' : '↕️ Ajustar';
      btn.title = isCompact ? 'Restaurar espaciado normal' : 'Modo compacto para pantallas pequeñas';
    }
  }

  async handleInitialSupabaseSetup() {
    const urlInput = document.getElementById('initSupabaseUrl');
    const keyInput = document.getElementById('initSupabaseKey');
    const btn = document.getElementById('btnInitSupabaseSubmit');
    const statusBox = document.getElementById('initSupabaseStatusBox');

    let url = urlInput ? urlInput.value.trim() : '';
    const key = keyInput ? keyInput.value.trim() : '';

    if (!url || !key) {
      alert('Ingresa la URL y Anon Key de Supabase.');
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
      if (urlInput) urlInput.value = url;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Descargando base...';
    }

    if (statusBox) {
      statusBox.style.display = 'block';
      statusBox.style.background = 'var(--bg-primary)';
      statusBox.style.borderColor = 'var(--border-color)';
      statusBox.style.color = 'var(--text-secondary)';
      statusBox.innerHTML = '⏳ Conectando con Supabase y descargando toda la base de datos...';
    }

    try {
      // 1. Guardar en settings locales
      const currentSettings = await storageService.getSettings();
      currentSettings.cloud = {
        provider: 'supabase',
        supabaseUrl: url,
        supabaseAnonKey: key
      };
      await storageService.saveSettings(currentSettings);
      this.appConfig = currentSettings;

      // 2. Inicializar cliente Supabase
      const clientOk = await supabaseService.initClient(url, key, true);
      if (!clientOk) {
        throw new Error('No se pudo inicializar la conexión con Supabase. Verifica la URL y la llave.');
      }

      // 3. Descargar todas las tablas desde Supabase hacia IndexedDB
      const syncRes = await supabaseService.syncAll();
      if (!syncRes.success && !syncRes.offline) {
        throw new Error(syncRes.error || 'Error al descargar datos de Supabase.');
      }

      // 4. Refrescar lista de usuarios locales en authService
      await authService.init();

      if (statusBox) {
        statusBox.style.background = 'rgba(16, 185, 129, 0.12)';
        statusBox.style.borderColor = 'var(--color-success, #10b981)';
        statusBox.style.color = 'var(--color-success, #10b981)';
        statusBox.innerHTML = '<strong>✅ ¡Base descargada con éxito!</strong> Reiniciando aplicación...';
      }

      this.showToast('¡Base de datos descargada! Reiniciando...', 'success');
      setTimeout(() => {
        window.location.reload();
      }, 1200);
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📥 Guardar y Descargar Base';
      }
      if (statusBox) {
        statusBox.style.background = 'rgba(239, 68, 68, 0.12)';
        statusBox.style.borderColor = 'var(--color-danger, #ef4444)';
        statusBox.style.color = 'var(--color-danger, #ef4444)';
        statusBox.innerHTML = `<strong>❌ Error:</strong> ${err.message}`;
      }
    }
  }

  async handleDownloadAndRestart() {
    const ok = confirm('¿Deseas descargar toda la base de datos desde Supabase y reiniciar la aplicación?');
    if (!ok) return;

    this.showToast('Descargando base de datos desde Supabase...', 'info');
    try {
      await supabaseService.initFromSettings();
      const res = await supabaseService.syncAll();
      if (res.success) {
        this.showToast('✅ Descarga completa. Reiniciando en 1 segundo...', 'success');
        setTimeout(() => window.location.reload(), 1000);
      } else {
        alert('Error al descargar: ' + (res.error || 'No se pudo conectar'));
      }
    } catch (e) {
      alert('Excepción: ' + e.message);
    }
  }

  async renderUsers() {
    const users = await authService.getAllUsers();
    const current = authService.getCurrentUser();
    const container = document.getElementById('usersListContainer');
    if (!container) return;

    container.innerHTML = users.map(u => {
      const isCurrent = current?.id === u.id;
      return `
        <div class="user-row-card">
          <div style="display: flex; align-items: center; gap: 0.85rem;">
            <div class="user-avatar-tag">${u.avatar || '👤'}</div>
            <div>
              <div style="font-weight: 700; font-size: 1rem; color: var(--text-primary); display: flex; align-items: center; gap: 0.5rem;">
                ${u.nombre}
                ${isCurrent ? '<span class="meta-pill" style="color: var(--color-success); font-weight: 700;">(Sesión Actual)</span>' : ''}
              </div>
              <div style="font-size: 0.825rem; color: var(--text-secondary);">
                <strong>${u.cargoTitulo || (u.rol === 'admin' ? 'Administrador General' : 'Despachador')}</strong>
                ${u.telefono ? ` &bull; 📞 ${u.telefono}` : ''}
                ${u.email ? ` &bull; ✉️ ${u.email}` : ''}
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <button class="btn btn-secondary btn-icon" title="Editar Usuario" onclick="window.app.openEditUserModal('${u.id}')">
              ✏️
            </button>
            ${!isCurrent ? `
              <button class="btn btn-secondary btn-icon" title="Eliminar Usuario" onclick="window.app.deleteUser('${u.id}')">
                🗑️
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  openNewUserModal() {
    if (!authService.isAdmin()) {
      alert('Solo un Administrador puede crear usuarios del sistema.');
      return;
    }
    document.getElementById('userModalTitle').textContent = '👥 Crear Usuario del Sistema';
    document.getElementById('userEditId').value = '';
    document.getElementById('userNameInput').value = '';
    document.getElementById('userRoleSelect').value = 'dispatcher';
    document.getElementById('userUsernameInput').value = '';
    document.getElementById('userPasswordInput').value = '';
    document.getElementById('userPhoneInput').value = '';
    document.getElementById('userEmailInput').value = '';
    this.openModal('userModal');
  }

  async openEditUserModal(id) {
    if (!authService.isAdmin()) {
      alert('Solo un Administrador puede modificar usuarios del sistema.');
      return;
    }
    const users = await authService.getAllUsers();
    const u = users.find(x => x.id === id);
    if (!u) return;

    document.getElementById('userModalTitle').textContent = '✏️ Editar Usuario del Sistema';
    document.getElementById('userEditId').value = u.id;
    document.getElementById('userNameInput').value = u.nombre || '';
    document.getElementById('userRoleSelect').value = u.rol || 'dispatcher';
    document.getElementById('userUsernameInput').value = u.usuario || '';
    document.getElementById('userPasswordInput').value = u.password || '';
    document.getElementById('userPhoneInput').value = u.telefono || '';
    document.getElementById('userEmailInput').value = u.email || '';
    this.openModal('userModal');
  }

  async submitUserForm() {
    const nombre = document.getElementById('userNameInput').value.trim();
    const usuario = document.getElementById('userUsernameInput').value.trim();
    const password = document.getElementById('userPasswordInput').value.trim();

    if (!nombre || !usuario || !password) {
      alert('El Nombre, Usuario de acceso y Contraseña son obligatorios.');
      return;
    }

    const userData = {
      id: document.getElementById('userEditId').value || undefined,
      nombre,
      usuario,
      password,
      rol: document.getElementById('userRoleSelect').value,
      telefono: document.getElementById('userPhoneInput').value.trim(),
      email: document.getElementById('userEmailInput').value.trim()
    };

    try {
      await authService.saveUser(userData);
      this.closeModal('userModal');
      this.showToast(`Usuario "${nombre}" guardado.`);
      this.updateNavSessionUI();
      this.renderUsers();
      this.applyRolePermissions();
    } catch (err) {
      alert(err.message);
    }
  }

  async deleteUser(id) {
    const ok = confirm('¿Deseas eliminar este usuario del sistema?');
    if (!ok) return;
    try {
      await authService.deleteUser(id);
      this.showToast('Usuario eliminado.');
      this.updateNavSessionUI();
      this.renderUsers();
    } catch (err) {
      alert(err.message);
    }
  }

  // ==========================================
  // ACCIONES RÁPIDAS: ABONO Y LIQUIDACIÓN TOTAL
  // ==========================================
  async openAddPaymentModal(orderId) {
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    this.selectedOrderForAction = order;
    const currency = this.appConfig?.empresa?.moneda || '$';

    document.getElementById('modalPayOrderId').textContent = order.id;
    document.getElementById('modalPayCustomerName').textContent = order.clienteNombre;
    document.getElementById('modalPayPendingBalance').textContent = `${currency} ${order.saldoPendiente.toFixed(2)}`;
    document.getElementById('modalPayAmountInput').value = order.saldoPendiente > 0 ? order.saldoPendiente : 0;
    document.getElementById('modalPayMethod').value = 'Efectivo';
    document.getElementById('modalPayRef').value = '';

    this.openModal('paymentModal');
  }

  async submitAddPayment() {
    if (!this.selectedOrderForAction) return;

    const monto = Number(document.getElementById('modalPayAmountInput').value);
    const metodo = document.getElementById('modalPayMethod').value;
    const ref = document.getElementById('modalPayRef').value;

    if (isNaN(monto) || monto <= 0) {
      alert('Ingresa un monto válido mayor a 0');
      return;
    }

    try {
      await orderService.addPayment(this.selectedOrderForAction.id, {
        monto,
        metodo,
        comprobanteRef: ref,
        concepto: 'Abono / Cuota de apartado'
      });

      this.closeModal('paymentModal');
      this.showToast(`Abono de ${this.appConfig.empresa.moneda} ${monto.toFixed(2)} registrado exitosamente.`);
      this.refreshCurrentView();
      this.updateGlobalBadgeMetrics();

      // Ofrecer envío de comprobante actualizado por WhatsApp
      const sendWsp = confirm('¿Deseas enviar el comprobante de este abono por WhatsApp al cliente?');
      if (sendWsp) {
        this.sendWhatsApp(this.selectedOrderForAction.id);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  // Liquidación total instantánea en 1 clic
  async quickFullSettlement(orderId) {
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    const currency = this.appConfig?.empresa?.moneda || '$';
    const confirmSettle = confirm(
      `¿Deseas registrar la CANCELACIÓN TOTAL del encargo ${order.id}?\n\n` +
      `Cliente: ${order.clienteNombre}\n` +
      `Monto a liquidar: ${currency} ${order.saldoPendiente.toFixed(2)}\n\n` +
      `El saldo quedará en 0 y el encargo pasará a estado LIQUIDADO.`
    );

    if (!confirmSettle) return;

    try {
      await orderService.settleFullBalance(orderId, 'Efectivo / Transferencia', 'Liquidación rápida en 1 clic');
      this.showToast(`¡Encargo ${order.id} liquidado en su totalidad!`);
      this.refreshCurrentView();
      this.updateGlobalBadgeMetrics();

      // Ofrecer comprobante de liquidación total por WhatsApp
      const sendWsp = confirm('¿Deseas enviar el comprobante de cancelación total por WhatsApp al cliente?');
      if (sendWsp) {
        this.sendWhatsApp(orderId);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  // Finalizar encargo y archivarlo como entregado (Exclusivo Administrador)
  async finalizeOrder(orderId) {
    if (!authService.isAdmin()) {
      alert('Acceso denegado: La función de finalizar y archivar pedidos es exclusiva para Administradores.');
      return;
    }
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    if (order.saldoPendiente > 0) {
      const currency = this.appConfig?.empresa?.moneda || '$';
      const confirmDebt = confirm(
        `⚠️ ATENCIÓN: El encargo ${order.id} aún tiene un saldo pendiente de ${currency} ${order.saldoPendiente.toFixed(2)}.\n\n` +
        `¿Deseas marcarlo como ENTREGADO y archivarlo en Pedidos Finalizados?`
      );
      if (!confirmDebt) return;
    } else {
      const confirmFin = confirm(
        `¿Deseas marcar el encargo ${order.id} (${order.clienteNombre}) como ENTREGADO y FINALIZADO?\n\n` +
        `Se archivará en la sección de Pedidos Finalizados y se removerá de la lista de activos en pantalla.`
      );
      if (!confirmFin) return;
    }

    try {
      await orderService.finalizeOrder(orderId);
      this.showToast(`¡Encargo ${order.id} finalizado y archivado con éxito!`);
      this.refreshCurrentView();
      this.updateGlobalBadgeMetrics();
    } catch (err) {
      alert('Error al finalizar el encargo: ' + err.message);
    }
  }

  // Alternar estado de productos adquiridos / comprados
  async toggleOrderAcquired(orderId) {
    try {
      const updated = await orderService.toggleOrderAcquired(orderId);
      if (updated.adquirido) {
        this.showToast(`🛍️ ¡Productos de ${orderId} marcados como ADQUIRIDOS! Ahora ya puedes realizar la entrega física.`, 'success');
      } else {
        this.showToast(`Encargo ${orderId} marcado como pendiente de adquisición`, 'info');
      }
      this.refreshCurrentView();
      await this.updateGlobalBadgeMetrics();
    } catch (err) {
      alert('Error al actualizar adquisición: ' + err.message);
    }
  }

  // Alternar estado de producto entregado al cliente
  async toggleOrderDelivered(orderId) {
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    const willBeDelivered = !order.entregado;

    // Regla de negocio requerida: Para poderse entregar primero se debe adquirir el producto
    if (willBeDelivered && !order.adquirido) {
      this.showToast('⚠️ Para poder entregar este pedido, primero debes adquirir los productos y marcarlos como "🛍️ Productos Adquiridos".', 'warning');
      return;
    }

    if (willBeDelivered && order.saldoPendiente > 0) {
      const currency = this.appConfig?.empresa?.moneda || '$';
      const confirmDebt = confirm(
        `⚠️ ATENCIÓN: El encargo ${order.id} tiene un saldo pendiente de ${currency} ${order.saldoPendiente.toFixed(2)}.\n\n` +
        `¿Confirmas la entrega física del producto al cliente manteniendo el saldo deudor pendiente por cobrar?`
      );
      if (!confirmDebt) return;
    }

    try {
      const updated = await orderService.toggleOrderDelivered(orderId);
      if (updated.entregado) {
        this.showToast(`📦 ¡Encargo ${orderId} marcado como ENTREGADO!`, 'success');
      } else {
        this.showToast(`Encargo ${orderId} marcado como pendiente de entrega`, 'info');
      }
      this.refreshCurrentView();
      this.updateGlobalBadgeMetrics();
    } catch (err) {
      alert('Error al actualizar entrega: ' + err.message);
    }
  }

  // Archivar encargo finalizado en historial (Exclusivo Administrador)
  async archiveFinalizedOrder(orderId) {
    if (!authService.isAdmin()) {
      alert('Acceso denegado: La función de archivar pedidos es exclusiva para Administradores.');
      return;
    }
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    if (order.saldoPendiente > 0) {
      const currency = this.appConfig?.empresa?.moneda || '$';
      const confirmDebt = confirm(
        `⚠️ ATENCIÓN: El encargo ${order.id} tiene un saldo pendiente de ${currency} ${order.saldoPendiente.toFixed(2)}.\n\n` +
        `¿Confirmas archivar este encargo en el historial manteniendo el saldo deudor registrado? Dejará de sumar en el tablero principal activo.`
      );
      if (!confirmDebt) return;
    } else {
      const confirmArchive = confirm(
        `¿Deseas archivar el encargo ${order.id} (${order.clienteNombre}) en el historial de Pedidos Finalizados?\n\n` +
        `Al archivarlo, se cerrará en el historial y dejará de sumar en el total recaudado del tablero principal.`
      );
      if (!confirmArchive) return;
    }

    try {
      await orderService.archiveFinalizedOrder(orderId);
      this.showToast(`📁 Encargo ${orderId} archivado con éxito. Se descontó del recaudado activo del tablero.`, 'success');
      this.refreshCurrentView();
      await this.updateGlobalBadgeMetrics();
    } catch (err) {
      console.error('Error al archivar encargo:', err);
      alert('Error al archivar encargo: ' + err.message);
    }
  }

  // Desarchivar / Restaurar encargo a pedidos activos (Exclusivo Administrador)
  async unarchiveOrder(orderId) {
    if (!authService.isAdmin()) {
      alert('Acceso denegado: La función de restaurar pedidos archivados es exclusiva para Administradores.');
      return;
    }
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    const confirmRestore = confirm(
      `¿Deseas restaurar el encargo ${order.id} (${order.clienteNombre}) y regresarlo a la pantalla de Encargos Activos?\n\n` +
      `Se desarchivará y se marcará como pendiente de entrega para continuar en seguimiento activo.`
    );
    if (!confirmRestore) return;

    try {
      await orderService.reopenOrder(orderId);
      this.showToast(`↩️ Encargo ${orderId} restaurado a pedidos activos.`);
      this.refreshCurrentView();
      await this.updateGlobalBadgeMetrics();
    } catch (err) {
      console.error('Error al restaurar encargo:', err);
      alert('Error al restaurar encargo: ' + err.message);
    }
  }

  // Eliminar encargo definitivamente de la base de datos (Exclusivo Administrador para limpiar base de datos)
  async confirmDeleteOrder(orderId) {
    if (!authService.isAdmin()) {
      alert('Acceso denegado: La eliminación definitiva de la base de datos es exclusiva para Administradores.');
      return;
    }
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    const confirmDel = confirm(
      `⚠️ ELIMINAR TOTALMENTE DE LA BASE DE DATOS:\n\n` +
      `¿Estás seguro de que deseas eliminar permanentemente el encargo ${order.id} de "${order.clienteNombre}"?\n\n` +
      `Esta acción limpiará definitivamente este registro de la base de datos y no se puede deshacer.`
    );
    if (!confirmDel) return;

    try {
      await orderService.deleteOrder(orderId);
      this.showToast(`🗑️ Encargo ${orderId} eliminado definitivamente de la base de datos.`);
      this.refreshCurrentView();
      await this.updateGlobalBadgeMetrics();
    } catch (err) {
      console.error('Error al eliminar encargo:', err);
      alert('Error al eliminar encargo: ' + err.message);
    }
  }

  // Reabrir encargo finalizado para regresarlo a pedidos activos (Exclusivo Administrador)
  async reopenOrder(orderId) {
    if (!authService.isAdmin()) {
      alert('Acceso denegado: Esta función es exclusiva para Administradores.');
      return;
    }
    const order = await orderService.getOrderById(orderId);
    if (!order) return;

    const confirmReopen = confirm(
      `¿Deseas reabrir el encargo ${order.id} (${order.clienteNombre}) para regresarlo a la pantalla de Pedidos Activos?`
    );
    if (!confirmReopen) return;

    try {
      await orderService.reopenOrder(orderId);
      this.showToast(`Encargo ${order.id} reabierto a pedidos activos.`);
      this.refreshCurrentView();
      this.updateGlobalBadgeMetrics();
    } catch (err) {
      alert('Error al reabrir el encargo: ' + err.message);
    }
  }

  // ==========================================
  // COMPROBANTES: TICKET, WHATSAPP, EMAIL
  // ==========================================
  async printTicket(orderId) {
    const order = await orderService.getOrderById(orderId);
    if (!order) return;
    printService.printOrderTicket(order, this.appConfig);
  }

  async sendWhatsApp(orderId) {
    const order = await orderService.getOrderById(orderId);
    if (!order) return;
    notificationService.openWhatsApp(order, this.appConfig);
  }

  async sendEmail(orderId) {
    const order = await orderService.getOrderById(orderId);
    if (!order) return;
    const customer = await customerService.getCustomerProfile(order.clienteId);
    notificationService.openEmail(order, this.appConfig, customer?.email);
  }

  // ==========================================
  // PERFIL DE CLIENTE (Historial y Saldos)
  // ==========================================
  async openCustomerProfile(customerId) {
    const profile = await customerService.getCustomerProfile(customerId);
    if (!profile) return;

    this.selectedCustomerProfile = profile;
    const currency = this.appConfig?.empresa?.moneda || '$';

    document.getElementById('profCustomerName').textContent = profile.nombre;
    const phoneEl = document.getElementById('profCustomerPhone');
    if (phoneEl) {
      if (profile.telefono) {
        const cleanPhone = notificationService.cleanPhoneNumber(profile.telefono, this.appConfig?.empresa?.prefijoPais || '+58');
        phoneEl.innerHTML = `<a href="https://wa.me/${cleanPhone}" target="_blank" rel="noopener noreferrer" style="color: #16a34a; text-decoration: none; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;" title="Abrir chat de WhatsApp">💬 ${profile.telefono} <span style="font-size: 0.75rem;">↗</span></a>`;
      } else {
        phoneEl.textContent = 'Sin teléfono';
      }
    }
    document.getElementById('profCustomerEmail').textContent = profile.email || 'Sin email';
    document.getElementById('profCustomerCity').textContent = profile.ciudadDefault || 'No especificada';
    document.getElementById('profCustomerAddress').textContent = profile.direccionDefault || 'No especificada';
    document.getElementById('profCustomerDebt').textContent = `${currency} ${profile.saldoDeudorTotal.toFixed(2)}`;
    document.getElementById('profCustomerTotalSpent').textContent = `${currency} ${profile.totalComprado.toFixed(2)}`;

    // Listado de pedidos del cliente
    const ordersContainer = document.getElementById('profOrdersList');
    if (ordersContainer) {
      if (!profile.pedidos || profile.pedidos.length === 0) {
        ordersContainer.innerHTML = `<p class="text-muted" style="text-align: center; padding: 1rem;">No tiene encargos registrados.</p>`;
      } else {
        ordersContainer.innerHTML = profile.pedidos.map(o => this.buildOrderCardHtml(o)).join('');
      }
    }

    this.openModal('customerProfileModal');
  }

  // ==========================================
  // MODAL DE NUEVO ENCARGO / APARTADO
  // ==========================================
  async openNewOrderModal() {
    const customers = await customerService.getCustomersWithBalances();
    const select = document.getElementById('newOrderCustomerSelect');
    
    // Llenar select de clientes
    let options = `<option value="">-- Seleccionar Cliente --</option>`;
    customers.forEach(c => {
      options += `<option value="${c.id}" data-phone="${c.telefono || ''}" data-city="${c.ciudadDefault || ''}">${c.nombre} (${c.telefono || 'S/N'})</option>`;
    });
    select.innerHTML = options;

    // Llenar selector de destinos guardados
    await this.populateSavedDestinationsSelect();
    const savedDestSelect = document.getElementById('newOrderSavedDestSelect');
    if (savedDestSelect) savedDestSelect.value = '';
    const saveCheck = document.getElementById('newOrderSaveAsFrequentDest');
    if (saveCheck) saveCheck.checked = false;

    // Resetear formulario
    document.getElementById('newOrderCityInput').value = '';
    document.getElementById('newOrderDeliveryPoint').value = '';
    document.getElementById('newOrderMapsUrl').value = '';
    this.currentOrderCoords = null;
    document.getElementById('newOrderDateInput').value = '';
    document.getElementById('newOrderCommission').value = '0';
    document.getElementById('newOrderDepositPercent').value = this.appConfig.empresa.anticipoDefault || 50;
    document.getElementById('newOrderFirstPayment').value = '0';

    // Resetear items
    const itemsTable = document.getElementById('newOrderItemsRows');
    itemsTable.innerHTML = `
      <div class="item-input-row">
        <input type="text" class="form-input item-desc" placeholder="Descripción del producto (ej. Calzados Nike)" required>
        <input type="number" class="form-input item-qty" value="1" min="1" required style="width: 70px;">
        <input type="number" class="form-input item-price" placeholder="Precio unitario" min="0" step="0.5" required>
        <button type="button" class="btn btn-icon btn-danger" onclick="this.closest('.item-input-row').remove(); window.app.calculateNewOrderTotals();">✕</button>
      </div>
    `;

    this.calculateNewOrderTotals();
    this.openModal('newOrderModal');
  }

  // Capturar coordenadas GPS del dispositivo para georreferenciar destino
  captureCurrentGPS() {
    if (!navigator.geolocation) {
      alert('La geolocalización GPS no está soportada en este navegador.');
      return;
    }

    this.showToast('Obteniendo ubicación GPS actual...', 'info');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(6);
        const lng = pos.coords.longitude.toFixed(6);
        this.currentOrderCoords = { lat, lng };
        const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
        const input = document.getElementById('newOrderMapsUrl');
        if (input) input.value = mapsUrl;
        this.showToast(`📍 Ubicación GPS capturada (${lat}, ${lng})`);
      },
      (err) => {
        alert('No se pudo obtener la señal GPS: ' + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  addNewItemRow(initialData = null) {
    const itemsTable = document.getElementById('newOrderItemsRows');
    const row = document.createElement('div');
    row.className = 'item-input-row';
    const desc = initialData?.descripcion || initialData?.nombre || '';
    const qty = initialData?.cantidad || 1;
    const price = initialData?.precioUnitario !== undefined ? initialData.precioUnitario : '';
    const prodId = initialData?.productoId || '';

    row.innerHTML = `
      <input type="hidden" class="item-prod-id" value="${prodId}">
      <input type="text" class="form-input item-desc" placeholder="Descripción de otro producto" value="${this.escapeHtml(desc)}" required>
      <input type="number" class="form-input item-qty" value="${qty}" min="1" required style="width: 70px;">
      <input type="number" class="form-input item-price" placeholder="Precio unitario" value="${price}" min="0" step="0.5" required>
      <button type="button" class="btn btn-icon btn-danger" onclick="this.closest('.item-input-row').remove(); window.app.calculateNewOrderTotals();">✕</button>
    `;
    itemsTable.appendChild(row);
    this.calculateNewOrderTotals();
  }

  calculateNewOrderTotals() {
    const currency = this.appConfig?.empresa?.moneda || '$';
    const rows = document.querySelectorAll('#newOrderItemsRows .item-input-row');
    let subtotal = 0;

    rows.forEach(r => {
      const qty = Number(r.querySelector('.item-qty')?.value) || 1;
      const price = Number(r.querySelector('.item-price')?.value) || 0;
      subtotal += (qty * price);
    });

    const commission = Number(document.getElementById('newOrderCommission')?.value) || 0;
    const total = subtotal + commission;

    const depositPercent = Number(document.getElementById('newOrderDepositPercent')?.value) || 50;
    const minDeposit = (total * (depositPercent / 100));

    document.getElementById('newOrderCalculatedTotal').textContent = `${currency} ${total.toFixed(2)}`;
    document.getElementById('newOrderCalculatedDeposit').textContent = `${currency} ${minDeposit.toFixed(2)}`;
  }

  async submitNewOrder() {
    const customerSelect = document.getElementById('newOrderCustomerSelect');
    const clienteId = customerSelect.value;

    if (!clienteId) {
      alert('Por favor selecciona o crea un cliente para este encargo.');
      return;
    }

    const selectedOption = customerSelect.options[customerSelect.selectedIndex];
    const clienteNombre = selectedOption.text.split('(')[0].trim();
    const clienteTelefono = selectedOption.dataset.phone || '';

    // Extraer items
    const rows = document.querySelectorAll('#newOrderItemsRows .item-input-row');
    const items = [];
    rows.forEach(r => {
      const desc = r.querySelector('.item-desc')?.value.trim();
      const qty = Number(r.querySelector('.item-qty')?.value) || 1;
      const price = Number(r.querySelector('.item-price')?.value) || 0;
      const productoId = r.querySelector('.item-prod-id')?.value || null;
      if (desc && price >= 0) {
        items.push({ descripcion: desc, cantidad: qty, precioUnitario: price, productoId: productoId || undefined });
      }
    });

    if (items.length === 0) {
      alert('Debes agregar al menos un producto con descripción y precio.');
      return;
    }

    const city = document.getElementById('newOrderCityInput').value.trim();
    const point = document.getElementById('newOrderDeliveryPoint').value.trim();
    const mapsUrl = document.getElementById('newOrderMapsUrl')?.value.trim() || '';
    const saveAsFrequent = document.getElementById('newOrderSaveAsFrequentDest')?.checked;
    const date = document.getElementById('newOrderDateInput').value;
    const commission = Number(document.getElementById('newOrderCommission').value) || 0;
    const depositPercent = Number(document.getElementById('newOrderDepositPercent').value) || 50;
    const firstPayment = Number(document.getElementById('newOrderFirstPayment').value) || 0;
    const firstPaymentMethod = document.getElementById('newOrderFirstPaymentMethod').value;

    try {
      const createdOrder = await orderService.saveOrder({
        clienteId,
        clienteNombre,
        clienteTelefono,
        lugarDestino: {
          ciudad: city || 'Por coordinar',
          puntoEntrega: point,
          mapsUrl: mapsUrl,
          lat: this.currentOrderCoords?.lat || null,
          lng: this.currentOrderCoords?.lng || null
        },
        fechaEntregaEstimada: date,
        items,
        costoEnvioComision: commission,
        anticipoExigidoTipo: 'porcentaje',
        anticipoExigidoValor: depositPercent,
        primerAbono: firstPayment,
        primerAbonoMetodo: firstPaymentMethod,
        primerAbonoRef: 'Anticipo inicial en creación'
      });

      // Si se vincularon productos del inventario, descontar stock automáticamente
      for (const itm of items) {
        if (itm.productoId) {
          try {
            await productService.adjustStock(itm.productoId, -itm.cantidad, 'delta');
          } catch (stkErr) {
            console.warn('[App] No se pudo descontar stock automáticamente:', stkErr);
          }
        }
      }

      // Si marcó "Guardar como destino / ubicación frecuente para futuros usos"
      if (saveAsFrequent && city) {
        try {
          await destinationService.saveDestination({
            nombre: point ? `${point} (${city})` : `Punto ${city}`,
            ciudad: city,
            categoria: 'Punto de Encuentro',
            direccion: point,
            mapsUrl: mapsUrl,
            lat: this.currentOrderCoords?.lat,
            lng: this.currentOrderCoords?.lng,
            notas: `Guardado automáticamente desde encargo ${createdOrder.id}`
          });
        } catch (e) {
          console.warn('No se pudo guardar automáticamente el destino frecuente:', e);
        }
      }

      this.closeModal('newOrderModal');
      this.showToast(`¡Encargo ${createdOrder.id} creado con éxito!`);
      this.refreshCurrentView();
      this.updateGlobalBadgeMetrics();

      // Ofrecer comprobante de inmediato
      const printNow = confirm('¿Deseas imprimir el Ticket de este encargo ahora?');
      if (printNow) {
        this.printTicket(createdOrder.id);
      }
    } catch (err) {
      alert('Error al crear encargo: ' + err.message);
    }
  }

  // ==========================================
  // MODAL DE NUEVO CLIENTE EXPRESS
  // ==========================================
  openNewCustomerModal() {
    document.getElementById('newCustName').value = '';
    document.getElementById('newCustPhone').value = '';
    document.getElementById('newCustEmail').value = '';
    document.getElementById('newCustCity').value = '';
    document.getElementById('newCustAddress').value = '';
    this.openModal('newCustomerModal');
  }

  async submitNewCustomer() {
    const nombre = document.getElementById('newCustName').value.trim();
    if (!nombre) {
      alert('El nombre del cliente es obligatorio.');
      return;
    }

    const customerData = {
      nombre,
      telefono: document.getElementById('newCustPhone').value.trim(),
      email: document.getElementById('newCustEmail').value.trim(),
      ciudadDefault: document.getElementById('newCustCity').value.trim(),
      direccionDefault: document.getElementById('newCustAddress').value.trim()
    };

    try {
      const saved = await customerService.saveCustomer(customerData);
      this.closeModal('newCustomerModal');
      this.showToast(`Cliente "${saved.nombre}" registrado con éxito.`);

      // Si el modal de nuevo encargo está abierto, refrescar su select y seleccionarlo
      const orderSelect = document.getElementById('newOrderCustomerSelect');
      if (orderSelect) {
        const option = document.createElement('option');
        option.value = saved.id;
        option.textContent = `${saved.nombre} (${saved.telefono || 'S/N'})`;
        option.dataset.phone = saved.telefono;
        option.dataset.city = saved.ciudadDefault;
        orderSelect.appendChild(option);
        orderSelect.value = saved.id;
        document.getElementById('newOrderCityInput').value = saved.ciudadDefault;
      }

      this.refreshCurrentView();
    } catch (err) {
      alert(err.message);
    }
  }

  // ==========================================
  // UTILIDADES GENERALES
  // ==========================================
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
      document.body.classList.add('modal-open');
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
    if (!document.querySelector('.modal-overlay.active')) {
      document.body.classList.remove('modal-open');
    }
  }

  refreshCurrentView() {
    this.switchView(this.currentView);
  }

  // ==========================================
  // REGISTRO DE EVENTOS DOM
  // ==========================================
  registerEventListeners() {
    // Tabs de navegación
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchView(tab.dataset.view);
      });
    });

    // Theme toggle
    document.getElementById('themeToggleBtn')?.addEventListener('click', () => this.toggleTheme());

    // Búsqueda en Omnibox Navbar
    const navSearchInput = document.getElementById('navSearchInput');
    if (navSearchInput) {
      navSearchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (this.currentView !== 'search') {
          this.switchView('search');
          const quickSearch = document.getElementById('quickSearchInput');
          if (quickSearch) quickSearch.value = val;
        }
        this.renderSearchOrders(val);
      });
    }

    // Búsqueda en la vista de búsqueda
    const quickSearchInput = document.getElementById('quickSearchInput');
    if (quickSearchInput) {
      quickSearchInput.addEventListener('input', (e) => {
        this.renderSearchOrders(e.target.value);
      });
    }

    // Filtros en pedidos
    document.getElementById('orderCityFilter')?.addEventListener('change', () => this.renderOrders());
    document.getElementById('orderStatusFilter')?.addEventListener('change', () => this.renderOrders());

    // Recalcular totales en nuevo pedido al cambiar inputs
    document.getElementById('newOrderCommission')?.addEventListener('input', () => this.calculateNewOrderTotals());
    document.getElementById('newOrderDepositPercent')?.addEventListener('input', () => this.calculateNewOrderTotals());
    document.getElementById('newOrderItemsRows')?.addEventListener('input', () => this.calculateNewOrderTotals());

    // Autollenar ciudad al cambiar cliente en nuevo pedido
    document.getElementById('newOrderCustomerSelect')?.addEventListener('change', (e) => {
      const opt = e.target.options[e.target.selectedIndex];
      if (opt && opt.dataset.city) {
        document.getElementById('newOrderCityInput').value = opt.dataset.city;
      }
    });

    // Autollenar datos al elegir destino guardado en nuevo encargo
    document.getElementById('newOrderSavedDestSelect')?.addEventListener('change', (e) => {
      const opt = e.target.options[e.target.selectedIndex];
      if (opt && opt.value) {
        if (opt.dataset.city) document.getElementById('newOrderCityInput').value = opt.dataset.city;
        if (opt.dataset.dir || opt.dataset.name) document.getElementById('newOrderDeliveryPoint').value = opt.dataset.dir || opt.dataset.name;
        if (opt.dataset.maps) document.getElementById('newOrderMapsUrl').value = opt.dataset.maps;
      }
    });

    // Búsqueda en tiempo real en catálogo de destinos y rutas
    document.getElementById('destinationsSearchInput')?.addEventListener('input', (e) => {
      this.renderDestinations(e.target.value);
    });

    // Búsqueda y filtros en tiempo real en Inventario & Catálogo
    document.getElementById('inventorySearchInput')?.addEventListener('input', (e) => {
      this.renderInventory(e.target.value);
    });
    document.getElementById('inventoryCategoryFilter')?.addEventListener('change', () => {
      this.renderInventory();
    });
    document.getElementById('inventoryStockFilter')?.addEventListener('change', () => {
      this.renderInventory();
    });

    // Desplegable / botón de configuración inicial de Supabase en login
    document.getElementById('btnToggleInitialSetup')?.addEventListener('click', () => {
      this.switchLoginMode('supabase');
    });

    // Desbloqueo de Administrador para reconfigurar Supabase en el Login
    const btnAdminUnlock = document.getElementById('btnAdminUnlockSupabase');
    if (btnAdminUnlock) {
      btnAdminUnlock.addEventListener('click', (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        this.switchLoginMode('admin-verify');
      });
    }

    const adminVerifyForm = document.getElementById('adminVerifyForm');
    if (adminVerifyForm) {
      adminVerifyForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleAdminUnlockSubmit();
      });
    }

    // Auto-scroll para evitar que el teclado virtual en móviles oculte los campos
    document.querySelectorAll('.login-card-container input').forEach(input => {
      input.addEventListener('focus', () => {
        setTimeout(() => {
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 250);
      });
    });

    // Botón de cerrar sesión en la barra superior
    document.getElementById('btnNavLogout')?.addEventListener('click', () => {
      this.handleNavLogout();
    });

    // Botón de alternar modo ruta / despachador para el Administrador
    document.getElementById('btnToggleDispatcherMode')?.addEventListener('click', () => {
      this.handleToggleDispatcherMode();
    });

    // Botón de descargar base completa y reiniciar desde Ajustes
    document.getElementById('btnDownloadAndRestart')?.addEventListener('click', () => {
      this.handleDownloadAndRestart();
    });

    // Botones de actualización de versión (Service Worker)
    document.getElementById('btnApplyUpdate')?.addEventListener('click', () => this.applyAppUpdate());
    document.getElementById('btnDismissUpdate')?.addEventListener('click', () => {
      const banner = document.getElementById('appUpdateBanner');
      if (banner) banner.style.display = 'none';
    });
    document.getElementById('btnCheckLoginUpdates')?.addEventListener('click', () => this.checkForAppUpdates(true));
    document.getElementById('btnCheckAppUpdates')?.addEventListener('click', () => this.checkForAppUpdates(true));

    // Respaldos, Nube y Sincronización Manual
    document.getElementById('btnManualSyncNow')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnManualSyncNow');
      const resultBox = document.getElementById('supabaseTestResultBox');
      const urlInput = document.getElementById('setSupabaseUrl');
      const keyInput = document.getElementById('setSupabaseKey');

      let url = urlInput ? urlInput.value.trim() : '';
      const key = keyInput ? keyInput.value.trim() : '';

      // Si se escribieron credenciales en el formulario, asegurarse de normalizar y guardar
      if (url && key) {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
          if (urlInput) urlInput.value = url;
        }
        const currentSettings = await storageService.getSettings();
        if (currentSettings.cloud.supabaseUrl !== url || currentSettings.cloud.supabaseAnonKey !== key) {
          currentSettings.cloud.supabaseUrl = url;
          currentSettings.cloud.supabaseAnonKey = key;
          await storageService.saveSettings(currentSettings);
          this.appConfig = currentSettings;
          await supabaseService.initClient(url, key, true);
        }
      } else {
        const currentSettings = await storageService.getSettings();
        if (!currentSettings?.cloud?.supabaseUrl || !currentSettings?.cloud?.supabaseAnonKey) {
          if (resultBox) {
            resultBox.style.display = 'block';
            resultBox.style.background = 'rgba(239, 68, 68, 0.12)';
            resultBox.style.borderColor = 'var(--color-danger, #ef4444)';
            resultBox.style.color = 'var(--color-danger, #ef4444)';
            resultBox.innerHTML = '<strong>⚠️ Sin credenciales:</strong> Ingresa tu <strong>Supabase URL</strong> y <strong>Anon Key</strong> antes de sincronizar.';
          }
          this.showToast('Ingresa las credenciales de Supabase primero', 'warning');
          return;
        }
      }

      btn.disabled = true;
      btn.innerHTML = '⏳ Sincronizando...';
      this.showToast('Iniciando sincronización...', 'info');

      if (resultBox) {
        resultBox.style.display = 'block';
        resultBox.style.background = 'var(--bg-tertiary, #1e293b)';
        resultBox.style.borderColor = 'var(--border-color)';
        resultBox.style.color = 'var(--text-secondary)';
        resultBox.innerHTML = '⏳ Sincronizando todas las tablas con Supabase y aplicando Guardián Anti-Pisado...';
      }

      try {
        const res = await syncService.syncWithCloud();
        if (res.success) {
          this.refreshCurrentView();
          this.updateGlobalBadgeMetrics();

          if (resultBox) {
            resultBox.style.background = 'rgba(16, 185, 129, 0.12)';
            resultBox.style.borderColor = 'var(--color-success, #10b981)';
            resultBox.style.color = 'var(--color-success, #10b981)';
            let details = '¡Base de datos sincronizada con Supabase!';
            if (res.updatedCount !== undefined || res.addedCount !== undefined) {
              details += ` (${res.addedCount || 0} nuevos agregados, ${res.updatedCount || 0} actualizados`;
              if (res.conflictsPrevented) {
                details += `, 🛡️ ${res.conflictsPrevented} protegidos anti-pisado`;
              }
              details += ')';
            }
            resultBox.innerHTML = `<strong>✅ Sincronización Exitosa:</strong> ${details}`;
          }
          this.showToast('¡Sincronización con la nube completada!', 'success');
        } else {
          if (resultBox) {
            resultBox.style.background = 'rgba(239, 68, 68, 0.12)';
            resultBox.style.borderColor = 'var(--color-danger, #ef4444)';
            resultBox.style.color = 'var(--color-danger, #ef4444)';
            resultBox.innerHTML = `<strong>❌ Error en sincronización:</strong> ${res.error || 'No se pudo conectar a la nube.'}`;
          }
          this.showToast(`Error: ${res.error}`, 'error');
        }
      } catch (err) {
        if (resultBox) {
          resultBox.style.display = 'block';
          resultBox.style.background = 'rgba(239, 68, 68, 0.12)';
          resultBox.style.borderColor = 'var(--color-danger, #ef4444)';
          resultBox.style.color = 'var(--color-danger, #ef4444)';
          resultBox.innerHTML = `<strong>❌ Excepción:</strong> ${err.message}`;
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🔄 Sincronizar con la Nube Ahora';
      }
    });

    document.getElementById('btnExportBackup')?.addEventListener('click', () => cloudService.exportBackupToFile());
    
    document.getElementById('btnImportBackupFile')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const res = await cloudService.importBackupFromFile(file);
        let msg = 'Base de datos restaurada con éxito.';
        if (res && res.conflictsPrevented > 0) {
          msg += ` 🛡️ Se protegieron ${res.conflictsPrevented} registros locales más nuevos para no ser pisados.`;
        }
        this.showToast(msg);
        this.refreshCurrentView();
        this.updateGlobalBadgeMetrics();
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btnTestSupabase')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnTestSupabase');
      const resultBox = document.getElementById('supabaseTestResultBox');
      const urlInput = document.getElementById('setSupabaseUrl');
      const keyInput = document.getElementById('setSupabaseKey');

      let url = urlInput ? urlInput.value.trim() : '';
      const key = keyInput ? keyInput.value.trim() : '';

      if (!url || !key) {
        if (resultBox) {
          resultBox.style.display = 'block';
          resultBox.style.background = 'rgba(239, 68, 68, 0.12)';
          resultBox.style.borderColor = 'var(--color-danger, #ef4444)';
          resultBox.style.color = 'var(--color-danger, #ef4444)';
          resultBox.innerHTML = '<strong>⚠️ Campos requeridos:</strong> Debes ingresar la <strong>Supabase URL</strong> y la <strong>Anon Key</strong> para probar la conexión.';
        }
        this.showToast('Ingresa la URL y Anon Key primero', 'warning');
        return;
      }

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
        if (urlInput) urlInput.value = url;
      }

      btn.disabled = true;
      btn.innerHTML = '⏳ Probando conexión...';
      if (resultBox) {
        resultBox.style.display = 'block';
        resultBox.style.background = 'var(--bg-tertiary, #1e293b)';
        resultBox.style.borderColor = 'var(--border-color)';
        resultBox.style.color = 'var(--text-secondary)';
        resultBox.innerHTML = '⏳ Conectando con los servidores de Supabase y verificando acceso a tablas...';
      }

      try {
        const res = await cloudService.testSupabaseConnection(url, key);

        if (resultBox) {
          resultBox.style.display = 'block';
          if (res.success && !res.warning) {
            resultBox.style.background = 'rgba(16, 185, 129, 0.12)';
            resultBox.style.borderColor = 'var(--color-success, #10b981)';
            resultBox.style.color = 'var(--color-success, #10b981)';
            resultBox.innerHTML = `<strong>✅ Conexión Exitosa:</strong> ${res.message}`;
            this.showToast('¡Conexión exitosa con Supabase!', 'success');
          } else if (res.warning) {
            resultBox.style.background = 'rgba(245, 158, 11, 0.12)';
            resultBox.style.borderColor = 'var(--color-warning, #f59e0b)';
            resultBox.style.color = '#d97706';
            resultBox.innerHTML = `<strong>⚠️ Advertencia:</strong> ${res.message} <br><button type="button" class="btn btn-secondary" style="margin-top:0.5rem; font-size:0.8rem; padding:0.25rem 0.5rem;" onclick="document.getElementById('btnShowSupabaseSql').click()">📋 Ver Script SQL para Crear Tablas</button>`;
            this.showToast('Conectado, pero faltan crear tablas', 'warning');
          } else {
            resultBox.style.background = 'rgba(239, 68, 68, 0.12)';
            resultBox.style.borderColor = 'var(--color-danger, #ef4444)';
            resultBox.style.color = 'var(--color-danger, #ef4444)';
            resultBox.innerHTML = `<strong>❌ Error de Conexión:</strong> ${res.message}`;
            this.showToast('Fallo al conectar con Supabase', 'error');
          }
        }
      } catch (err) {
        if (resultBox) {
          resultBox.style.display = 'block';
          resultBox.style.background = 'rgba(239, 68, 68, 0.12)';
          resultBox.style.borderColor = 'var(--color-danger, #ef4444)';
          resultBox.style.color = 'var(--color-danger, #ef4444)';
          resultBox.innerHTML = `<strong>❌ Excepción:</strong> ${err.message}`;
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Probar Conexión Supabase';
      }
    });

    document.getElementById('btnShowSupabaseSql')?.addEventListener('click', () => {
      const sql = supabaseService.getSetupSQL();
      const codeEl = document.getElementById('supabaseSqlCode');
      if (codeEl) codeEl.textContent = sql;
      this.openModal('supabaseSqlModal');
    });

    document.getElementById('btnCopySupabaseSql')?.addEventListener('click', async () => {
      const sql = supabaseService.getSetupSQL();
      try {
        await navigator.clipboard.writeText(sql);
        this.showToast('📋 ¡Script SQL copiado al portapapeles!');
      } catch (e) {
        const codeEl = document.getElementById('supabaseSqlCode');
        if (codeEl) {
          const range = document.createRange();
          range.selectNodeContents(codeEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('copy');
          this.showToast('📋 ¡Script SQL copiado!');
        }
      }
    });

    document.getElementById('btnLoadDemoData')?.addEventListener('click', async () => {
      const ok = confirm('¿Deseas precargar clientes y pedidos de demostración?');
      if (ok) {
        await cloudService.seedDemoData();
        this.showToast('Datos de demostración cargados.');
        this.refreshCurrentView();
        this.updateGlobalBadgeMetrics();
      }
    });
  }
}

// Inicializar la aplicación al cargar el DOM
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  window.app.init();
});
