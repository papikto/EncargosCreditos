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

class App {
  constructor() {
    this.currentView = 'dashboard';
    this.appConfig = null;
    this.selectedOrderForAction = null;
    this.selectedCustomerProfile = null;
    this.waitingWorker = null;
    this.currentOrderCoords = null;
    this.currentDestinationCoords = null;
  }

  async init() {
    // 1. Cargar configuración inicial
    this.appConfig = await storageService.getSettings();
    this.applyTheme();

    // 2. Inicializar sistema de usuarios por cargo y jerarquías
    await authService.init();

    // 3. Registrar e inicializar Service Worker (PWA Offline & Actualizaciones)
    this.initServiceWorker();

    // 4. Inicializar sincronizador y guardián anti-colisión
    this.initSync();

    // 5. Destinos por defecto solo si la base está totalmente vacía
    await destinationService.seedDefaultDestinationsIfEmpty();

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

      // Si ya hay una nueva versión en espera
      if (registration.waiting) {
        this.showUpdateBanner(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // Se detectó una nueva versión lista
            this.showUpdateBanner(newWorker);
          }
        });
      });
    }).catch((err) => {
      console.warn('[App] Error al registrar Service Worker:', err);
    });

    // Cuando el nuevo service worker toma el control, recargar suavemente
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
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
      window.location.reload();
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
        settings: 'Configuración'
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

  // ==========================================
  // Enrutador de Vistas
  // ==========================================
  switchView(viewName) {
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

    this.currentView = viewName;

    // Actualizar tabs activas
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === viewName);
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
    if (viewName === 'customers') this.renderCustomers();
    if (viewName === 'settings') this.renderSettings();
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

    // Renderizar encargos más recientes
    const orders = await orderService.getAllOrders();
    const recentOrdersContainer = document.getElementById('dashRecentOrdersList');
    if (recentOrdersContainer) {
      const top5 = orders.slice(0, 5);
      if (top5.length === 0) {
        recentOrdersContainer.innerHTML = `<p class="text-muted" style="padding: 1rem; text-align: center;">No hay encargos aún.</p>`;
      } else {
        recentOrdersContainer.innerHTML = top5.map(o => this.buildOrderCardHtml(o)).join('');
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
  async renderOrders() {
    const orders = await orderService.getAllOrders();
    const cityFilter = document.getElementById('orderCityFilter')?.value || 'all';
    const statusFilter = document.getElementById('orderStatusFilter')?.value || 'all';

    let filtered = orders;
    if (cityFilter !== 'all') {
      filtered = filtered.filter(o => o.lugarDestino?.ciudad === cityFilter);
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter(o => o.estado === statusFilter);
    }

    // Llenar selector de ciudades con las ciudades existentes
    this.populateCityFilter(orders);

    const container = document.getElementById('ordersListContainer');
    if (!container) return;

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">📦</div>
          <p style="font-size: 1.1rem; font-weight: 600;">No hay pedidos con los filtros seleccionados</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(order => this.buildOrderCardHtml(order)).join('');
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
  // (Con botones de Abono, Liquidación Total en 1 clic, WhatsApp, Ticket y Email)
  // ==========================================
  buildOrderCardHtml(order) {
    const currency = this.appConfig?.empresa?.moneda || '$';

    // Generar estado amigable
    let statusBadgeClass = 'active';
    let statusLabel = 'Apartado / En curso';

    if (order.estado === 'pendiente_anticipo') {
      statusBadgeClass = 'pending';
      statusLabel = '🟡 Falta Anticipo';
    } else if (order.saldoPendiente === 0) {
      statusBadgeClass = 'paid';
      statusLabel = '🟢 Liquidado al 100%';
    } else if (order.estado === 'entregado') {
      statusBadgeClass = 'delivered';
      statusLabel = 'Entregado';
    }

    // Lista de productos compacta
    const productsHtml = (order.items || []).map(it => `
      <div class="product-row-preview">
        <span class="product-name-qty"><strong>${it.cantidad}x</strong> ${it.descripcion}</span>
        <span class="product-price-val">${currency} ${(it.cantidad * it.precioUnitario).toFixed(2)}</span>
      </div>
    `).join('');

    const isLiquidated = order.saldoPendiente === 0;

    return `
      <div class="order-item-card" data-order-id="${order.id}">
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
              ${order.fechaEntregaEstimada ? `<span class="meta-pill">📅 Entrega: ${order.fechaEntregaEstimada}</span>` : ''}
              ${order.clienteTelefono ? `<span class="meta-pill">📞 ${order.clienteTelefono}</span>` : ''}
            </div>
          </div>
          <div>
            <span class="status-badge ${statusBadgeClass}">${statusLabel}</span>
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
              <span class="stat-amount ${isLiquidated ? 'paid' : 'debt'}">
                ${isLiquidated ? 'PAGADO COMPLETO' : `${currency} ${order.saldoPendiente.toFixed(2)}`}
              </span>
            </div>
          </div>

          <!-- Barra de Progreso de pago del Apartado -->
          <div class="progress-bar-container">
            <div class="progress-bar-fill ${isLiquidated ? 'complete' : ''}" style="width: ${order.porcentajePagado}%;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted);">
            <span>Anticipo requerido: ${currency} ${order.montoAnticipoCalculado.toFixed(2)} (${order.anticipoExigidoValor}%)</span>
            <span><strong>${order.porcentajePagado}%</strong> pagado</span>
          </div>
        </div>

        <!-- Barra de Acciones Rápidas -->
        <div class="order-actions-toolbar">
          <div class="quick-financial-actions">
            ${!isLiquidated ? `
              <button class="btn btn-success" onclick="window.app.openAddPaymentModal('${order.id}')" title="Agregar abono / cuota de apartado">
                ➕ Agregar Abono
              </button>
              <button class="btn btn-warning" onclick="window.app.quickFullSettlement('${order.id}')" title="Liquidar el 100% restante en 1 clic">
                ⚡ Cancelación Total
              </button>
            ` : `
              <span style="font-size: 0.85rem; font-weight: 700; color: var(--color-success); display: flex; align-items: center; gap: 4px;">
                ✅ Totalmente Cancelado
              </span>
            `}
          </div>

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
          </div>
        </div>
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
              ${c.telefono ? `<span class="meta-pill">📞 ${c.telefono}</span>` : ''}
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
    document.getElementById('destinationModal').classList.add('active');
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

    document.getElementById('destinationModal').classList.add('active');
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
  // AUTENTICACIÓN, SESIÓN & CONTROL DE ROLES
  // ==========================================
  checkAuthenticationState() {
    const isAuth = authService.isAuthenticated();
    const loginOverlay = document.getElementById('appLoginOverlay');
    const initBox = document.getElementById('initialSupabaseSetupBox');
    const isSupabaseConfigured = !!(this.appConfig?.cloud?.supabaseUrl && this.appConfig?.cloud?.supabaseAnonKey);

    if (!isAuth) {
      if (loginOverlay) {
        loginOverlay.style.display = 'flex';
      }
      // Si la base no tiene Supabase configurado en este dispositivo, sugerir el formulario inicial
      if (!isSupabaseConfigured && initBox) {
        initBox.style.display = 'block';
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

    if (sessionContainer) sessionContainer.style.display = 'inline-flex';
    if (avatarEl) avatarEl.textContent = user.avatar || (user.rol === 'admin' ? '👑' : '🚚');
    if (nameEl) nameEl.textContent = user.nombre;

    if (roleEl) {
      if (authService.isSimulatedDispatcher()) {
        roleEl.textContent = '👑 Modo Ruta Activo';
        roleEl.style.color = 'var(--brand-primary)';
      } else {
        roleEl.textContent = user.cargoTitulo || (user.rol === 'admin' ? 'Administrador General' : 'Despachador');
        roleEl.style.color = '';
      }
    }

    if (toggleBtn) {
      // Solo el Administrador puede alternar modo ruta / despachador
      if (user.rol === 'admin') {
        toggleBtn.style.display = 'inline-flex';
        if (authService.isSimulatedDispatcher()) {
          toggleBtn.innerHTML = '👑 Volver a Admin';
          toggleBtn.className = 'btn btn-primary';
          toggleBtn.title = 'Regresar al modo Administrador con acceso total';
        } else {
          toggleBtn.innerHTML = '🚚 Modo Ruta';
          toggleBtn.className = 'btn btn-secondary';
          toggleBtn.title = 'Alternar temporalmente a modo despachador para operar entregas';
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
    const tabCustomers = document.getElementById('navTabCustomers');
    const tabSettings = document.getElementById('navTabSettings');

    if (isAdmin) {
      // 👑 ADMINISTRADOR: Acceso total a todas las interfaces
      if (tabDashboard) tabDashboard.style.display = 'flex';
      if (tabSearch) tabSearch.style.display = 'flex';
      if (tabOrders) tabOrders.style.display = 'flex';
      if (tabDestinations) tabDestinations.style.display = 'flex';
      if (tabCustomers) tabCustomers.style.display = 'flex';
      if (tabSettings) tabSettings.style.display = 'flex';
    } else {
      // 🚚 DESPACHADOR: Solo le atañe el modo despachador
      // Ocultar configuración, panel de finanzas y CRM de clientes
      if (tabDashboard) tabDashboard.style.display = 'none';
      if (tabCustomers) tabCustomers.style.display = 'none';
      if (tabSettings) tabSettings.style.display = 'none';

      // Mantener operativas las vistas de logística:
      if (tabOrders) tabOrders.style.display = 'flex';
      if (tabSearch) tabSearch.style.display = 'flex';
      if (tabDestinations) tabDestinations.style.display = 'flex';
    }

    const brandTag = document.querySelector('.brand-tag');
    if (brandTag && current) {
      if (authService.isSimulatedDispatcher()) {
        brandTag.textContent = `v1.4.0 (Modo Ruta / Despacho)`;
      } else if (isAdmin) {
        brandTag.textContent = `v1.4.0 (Administrador)`;
      } else {
        brandTag.textContent = `v1.4.0 (Despachador)`;
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
    document.getElementById('userModal').classList.add('active');
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
    document.getElementById('userModal').classList.add('active');
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

    document.getElementById('paymentModal').classList.add('active');
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
    document.getElementById('profCustomerPhone').textContent = profile.telefono || 'Sin teléfono';
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

    document.getElementById('customerProfileModal').classList.add('active');
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
    document.getElementById('newOrderModal').classList.add('active');
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

  addNewItemRow() {
    const itemsTable = document.getElementById('newOrderItemsRows');
    const row = document.createElement('div');
    row.className = 'item-input-row';
    row.innerHTML = `
      <input type="text" class="form-input item-desc" placeholder="Descripción de otro producto" required>
      <input type="number" class="form-input item-qty" value="1" min="1" required style="width: 70px;">
      <input type="number" class="form-input item-price" placeholder="Precio unitario" min="0" step="0.5" required>
      <button type="button" class="btn btn-icon btn-danger" onclick="this.closest('.item-input-row').remove(); window.app.calculateNewOrderTotals();">✕</button>
    `;
    itemsTable.appendChild(row);
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
    const customerId = customerSelect.value;

    if (!customerId) {
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
      if (desc && price >= 0) {
        items.push({ descripcion: desc, cantidad: qty, precioUnitario: price });
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
    document.getElementById('newCustomerModal').classList.add('active');
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
    if (modal) modal.classList.add('active');
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
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

    // Desplegable de configuración inicial de Supabase en login
    document.getElementById('btnToggleInitialSetup')?.addEventListener('click', () => {
      const box = document.getElementById('initialSupabaseSetupBox');
      if (box) {
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
      }
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
