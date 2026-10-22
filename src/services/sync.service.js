/**
 * SyncService - DeepSeek Harness Provider
 * Sincronización Nube Híbrida (Supabase) & Guardián Anti-Colisión (Protección contra pisado de datos).
 */

import { storageService } from './storage.service.js';

class SyncService {
  constructor() {
    this.syncStatus = 'idle'; // 'idle' | 'syncing' | 'synced' | 'offline' | 'pending_upload' | 'error'
    this.statusListeners = [];
    this.initNetworkListeners();
  }

  // Registrar observadores de estado de sincronización
  onStatusChange(callback) {
    this.statusListeners.push(callback);
    callback(this.syncStatus, this.getStatusDetails());
  }

  notifyStatus(status, details = '') {
    this.syncStatus = status;
    const info = this.getStatusDetails(details);
    this.statusListeners.forEach(cb => {
      try { cb(status, info); } catch (e) { console.error(e); }
    });
  }

  getStatusDetails(customDetails = '') {
    if (customDetails) return customDetails;
    if (!navigator.onLine) return 'Modo Offline (Trabajando con última base local)';
    if (this.syncStatus === 'synced') return 'Base de datos sincronizada con la nube';
    if (this.syncStatus === 'syncing') return 'Sincronizando con la nube...';
    if (this.syncStatus === 'pending_upload') return 'Cambios locales pendientes de subida';
    return 'Listo';
  }

  // Detección de cambios de red
  initNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('[SyncService] Conexión a internet restablecida.');
      this.notifyStatus('syncing', 'Conexión detectada. Verificando sincronización...');
      this.syncWithCloud();
    });

    window.addEventListener('offline', () => {
      console.log('[SyncService] Sin conexión a internet. Entrando en modo offline.');
      this.notifyStatus('offline', 'Modo Offline (Trabajando con la última base cargada)');
    });
  }

  /**
   * GUARDIÁN ANTI-COLISIÓN: Fusión inteligente registro por registro.
   * Evita que una base de datos antigua pise datos más recientes.
   * 
   * @param {Array} localItems - Registros de la base local
   * @param {Array} incomingItems - Registros entrantes (de la nube o de un archivo importado)
   * @returns {Object} { mergedItems, conflictsPrevented, updatedCount, addedCount }
   */
  mergeRecords(localItems = [], incomingItems = []) {
    const localMap = new Map();
    localItems.forEach(item => localMap.set(item.id, item));

    let conflictsPrevented = 0;
    let updatedCount = 0;
    let addedCount = 0;

    incomingItems.forEach(incoming => {
      if (!incoming || !incoming.id) return;

      const local = localMap.get(incoming.id);

      if (!local) {
        // Registro nuevo que no existía localmente -> Se agrega
        localMap.set(incoming.id, incoming);
        addedCount++;
      } else {
        // El registro existe en ambos: Comparamos fechas de actualización (updatedAt)
        const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
        const incomingTime = new Date(incoming.updatedAt || incoming.createdAt || 0).getTime();

        if (incomingTime > localTime) {
          // El entrante es más reciente -> Se actualiza preservando propiedades si vienen vacías
          const merged = { ...local, ...incoming };
          if (incoming.adquirido === undefined || incoming.adquirido === null) {
            merged.adquirido = Boolean(local.adquirido);
          }
          if (incoming.archivado === undefined || incoming.archivado === null) {
            merged.archivado = Boolean(local.archivado);
          } else if (local.archivado && !incoming.archivado) {
            merged.archivado = true;
            merged.fechaArchivado = local.fechaArchivado;
          }
          if (incoming.entregado === undefined || incoming.entregado === null) {
            merged.entregado = Boolean(local.entregado);
          }
          localMap.set(incoming.id, merged);
          updatedCount++;
        } else if (localTime >= incomingTime) {
          // ¡ALERTA ANTI-PISADO! El dato local es más reciente o igual.
          // Se mantiene el local y se previene que la base remota lo sobrescriba.
          conflictsPrevented++;
          console.warn(`[SyncService] Protección anti-pisado: Registro local ${local.id} es más reciente o igual (${new Date(localTime).toISOString()}) que el entrante (${new Date(incomingTime).toISOString()}).`);
        }
      }
    });

    return {
      mergedItems: Array.from(localMap.values()),
      conflictsPrevented,
      updatedCount,
      addedCount
    };
  }

  /**
   * Sincronización bidireccional segura con Supabase.
   * Utiliza el nuevo SupabaseService con soporte de tablas independientes y Realtime.
   */
  async syncWithCloud() {
    if (!navigator.onLine) {
      this.notifyStatus('offline', 'Sin conexión: Usando última base local');
      return { success: true, offline: true };
    }

    const settings = await storageService.getSettings();
    const { supabaseUrl, supabaseAnonKey } = settings.cloud || {};

    if (!supabaseUrl || !supabaseAnonKey) {
      this.notifyStatus('idle', 'Almacenamiento Local (Nube no configurada)');
      return { success: true, cloudConfigured: false };
    }

    this.notifyStatus('syncing', 'Conectando con Supabase...');

    // Intentar sincronización con SupabaseService (tablas individuales + Realtime)
    try {
      const { supabaseService } = await import('./supabase.service.js');
      if (!supabaseService.isConfigured()) {
        await supabaseService.initClient(supabaseUrl, supabaseAnonKey, true);
      }
      const syncResult = await supabaseService.syncAll();
      if (syncResult.success) {
        this.notifyStatus('synced', '🟢 Base de datos sincronizada con Supabase (Realtime Activo)');
        return { success: true, ...syncResult };
      }
    } catch (realtimeErr) {
      console.warn('[SyncService] Falló sincronización de tablas, intentando snapshot de contingencia:', realtimeErr.message);
    }

    // Fallback: Sincronización por snapshot en app_sync_snapshots
    try {
      const cleanUrl = supabaseUrl.replace(/\/+$/, '');
      const headers = {
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      };

      const checkRes = await fetch(`${cleanUrl}/rest/v1/app_sync_snapshots?select=*&order=updatedAt.desc&limit=1`, {
        headers
      });

      if (checkRes.ok) {
        const remoteSnapshots = await checkRes.json();
        const localCustomers = await storageService.getAll('customers');
        const localOrders = await storageService.getAll('orders');

        if (remoteSnapshots && remoteSnapshots.length > 0) {
          const remoteData = remoteSnapshots[0].data || {};
          const remoteCustomers = remoteData.customers || [];
          const remoteOrders = remoteData.orders || [];

          const mergedCustomersResult = this.mergeRecords(localCustomers, remoteCustomers);
          const mergedOrdersResult = this.mergeRecords(localOrders, remoteOrders);

          for (const c of mergedCustomersResult.mergedItems) {
            await storageService.put('customers', c);
          }
          for (const o of mergedOrdersResult.mergedItems) {
            await storageService.put('orders', o);
          }
        }
      }

      const currentFullData = await storageService.exportDatabase();
      const payload = {
        id: 'global-state',
        updatedAt: new Date().toISOString(),
        data: currentFullData.data
      };

      await fetch(`${cleanUrl}/rest/v1/app_sync_snapshots`, {
        method: 'POST',
        headers: {
          ...headers,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      });

      this.notifyStatus('synced', 'Base de datos sincronizada con la nube');
      return { success: true };
    } catch (err) {
      console.warn('[SyncService] Error en fallback de sincronización:', err.message);
      this.notifyStatus('offline', `Trabajando localmente (${err.message.slice(0, 35)}...)`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Importación Segura de Respaldo JSON con Protección Anti-Pisado
   */
  async safeImportBackup(jsonData, forceOverwrite = false) {
    if (!jsonData || !jsonData.data) {
      throw new Error('Archivo de respaldo con formato inválido.');
    }

    const { customers = [], orders = [] } = jsonData.data;
    const localCustomers = await storageService.getAll('customers');
    const localOrders = await storageService.getAll('orders');

    if (forceOverwrite) {
      // Reemplazo completo explícito solicitado por el usuario
      for (const c of customers) await storageService.put('customers', c);
      for (const o of orders) await storageService.put('orders', o);
      if (jsonData.data.settings) await storageService.saveSettings(jsonData.data.settings);
      return { overwritten: true };
    }

    // Fusión inteligente protegiendo datos locales más nuevos
    const custRes = this.mergeRecords(localCustomers, customers);
    const ordRes = this.mergeRecords(localOrders, orders);

    for (const c of custRes.mergedItems) await storageService.put('customers', c);
    for (const o of ordRes.mergedItems) await storageService.put('orders', o);

    return {
      conflictsPrevented: custRes.conflictsPrevented + ordRes.conflictsPrevented,
      customersAdded: custRes.addedCount,
      customersUpdated: custRes.updatedCount,
      ordersAdded: ordRes.addedCount,
      ordersUpdated: ordRes.updatedCount
    };
  }
}

export const syncService = new SyncService();
