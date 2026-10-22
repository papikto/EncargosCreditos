/**
 * SupabaseService - DeepSeek Harness Provider
 * Servicio Experto de Sincronización y Realtime con Supabase
 *
 * Características avanzadas:
 * 1. Inicialización reactiva con URL y Anon Key pública.
 * 2. Carga dinámica e independiente de @supabase/supabase-js (vía ESM CDN o window.supabase).
 * 3. Escucha en tiempo real (PostgreSQL Replication & WebSockets) para todas las tablas:
 *    - customers
 *    - orders
 *    - destinations
 *    - users
 *    - settings
 * 4. Guardián Anti-Pisado / Anti-Colisión (resolución Last-Write-Wins verificada con updatedAt).
 * 5. Cola Offline bidireccional (Offline Queue) con reintentos automáticos al recuperar conexión.
 * 6. Despacho reactivo de eventos a la UI para actualización automática sin recargar.
 * 7. Generador de esquema SQL completo con políticas RLS y Realtime para Supabase.
 */

import { storageService } from './storage.service.js';

// Tablas principales del sistema
export const SYNC_TABLES = ['customers', 'orders', 'destinations', 'users', 'settings'];

// Clave para almacenamiento de cola offline y columnas no soportadas en Supabase
const OFFLINE_QUEUE_KEY = 'supabase_offline_queue_v1';
const UNSUPPORTED_COLUMNS_KEY = 'supabase_unsupported_columns_v1';

class SupabaseService {
  constructor() {
    this.client = null;
    this.realtimeChannel = null;
    this.status = 'unconfigured'; // 'unconfigured' | 'connecting' | 'connected' | 'realtime_active' | 'syncing' | 'offline' | 'error'
    this.statusMessage = 'Nube no configurada';
    this.listeners = [];
    this.syncEventListeners = [];
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.recentEventCache = new Map(); // Para deduplicación de eventos Realtime
    this.recentOutboundPushes = new Map(); // Para supresión de eco propio en Realtime
    this.isFlushingQueue = false;
    this.unsupportedColumns = null;

    // Escuchar eventos nativos de conectividad del navegador
    this.initNetworkListeners();
    this.loadUnsupportedColumns();
  }

  // ==========================================
  // CARGADOR DINÁMICO DEL SDK SUPABASE
  // ==========================================
  async getSDK() {
    // 1. Si ya está cargado en el entorno global (ej. vía script en index.html)
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      return window.supabase;
    }

    // 2. Intentar importación dinámica ESM desde esm.sh
    try {
      const module = await import('https://esm.sh/@supabase/supabase-js@2');
      if (module && module.createClient) {
        return module;
      }
    } catch (err1) {
      console.warn('[SupabaseService] Falló importación desde esm.sh, probando cdn.jsdelivr.net...', err1);
    }

    // 3. Fallback: jsdelivr ESM
    try {
      const module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      if (module && module.createClient) {
        return module;
      }
    } catch (err2) {
      console.error('[SupabaseService] Error cargando SDK de Supabase:', err2);
      throw new Error('No se pudo cargar la librería cliente de Supabase. Verifica tu conexión a internet.');
    }
  }

  // ==========================================
  // INICIALIZACIÓN DEL CLIENTE
  // ==========================================
  /**
   * Configura e inicializa el cliente con la URL y la Anon Key
   * @param {string} url - URL del proyecto Supabase (ej: https://xyz.supabase.co)
   * @param {string} anonKey - Llave pública anónima de Supabase
   * @param {boolean} autoSubscribe - Iniciar escucha en tiempo real inmediatamente
   */
  async initClient(url, anonKey, autoSubscribe = true) {
    if (!url || !anonKey) {
      this.disconnect();
      this.updateStatus('unconfigured', 'Almacenamiento Local (Supabase no configurado)');
      return false;
    }

    let cleanUrl = url.trim().replace(/\/+$/, '');
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    const cleanKey = anonKey.trim();

    try {
      this.updateStatus('connecting', 'Conectando con Supabase...');

      const sdk = await this.getSDK();
      this.client = sdk.createClient(cleanUrl, cleanKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        },
        realtime: {
          params: {
            eventsPerSecond: 10
          }
        }
      });

      console.log('[SupabaseService] Cliente Supabase configurado con éxito:', cleanUrl);

      // Si hay conexión a internet y se solicitó, suscribir canales en tiempo real
      if (navigator.onLine && autoSubscribe) {
        await this.subscribeToAllTables();
        // Procesar cambios pendientes en la cola offline si existían
        this.flushOfflineQueue().catch(console.error);
      } else if (!navigator.onLine) {
        this.updateStatus('offline', 'Modo Offline (Cliente configurado)');
      }

      return true;
    } catch (err) {
      console.error('[SupabaseService] Error al inicializar cliente Supabase:', err);
      this.updateStatus('error', `Error de configuración: ${err.message}`);
      return false;
    }
  }

  /**
   * Carga la configuración guardada en IndexedDB e inicia el cliente
   */
  async initFromSettings() {
    try {
      const settings = await storageService.getSettings();
      const { supabaseUrl, supabaseAnonKey } = settings?.cloud || {};

      if (supabaseUrl && supabaseAnonKey) {
        return await this.initClient(supabaseUrl, supabaseAnonKey, true);
      } else {
        this.updateStatus('unconfigured', 'Modo Local (Sin credenciales en nube)');
        return false;
      }
    } catch (err) {
      console.warn('[SupabaseService] No se pudieron cargar settings para Supabase:', err);
      return false;
    }
  }

  isConfigured() {
    return !!this.client;
  }

  // ==========================================
  // ESCUCHA EN TIEMPO REAL (REALTIME)
  // ==========================================
  /**
   * Suscribe un canal WebSocket que escucha eventos de inserción, actualización
   * y eliminación en tiempo real para todas las tablas del proyecto.
   */
  async subscribeToAllTables() {
    if (!this.client) return;

    // Desconectar canal previo si ya existía
    if (this.realtimeChannel) {
      try {
        await this.client.removeChannel(this.realtimeChannel);
      } catch (e) {
        // Ignorar si ya estaba cerrado
      }
      this.realtimeChannel = null;
    }

    const channelId = `realtime:encargos:${Date.now()}`;
    let channel = this.client.channel(channelId);

    // 1. Escucha por tabla específica para máxima compatibilidad con esquemas Supabase
    SYNC_TABLES.forEach((table) => {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => this.handleIncomingRealtimePayload(payload)
      );
    });

    // 2. Wildcard general para capturar tablas dinámicas o futuras en el esquema public
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public' },
      (payload) => {
        // Evitar duplicar si ya fue capturado por los manejadores por tabla
        if (!SYNC_TABLES.includes(payload.table)) {
          this.handleIncomingRealtimePayload(payload);
        }
      }
    );

    // 3. Suscribir y monitorear el estado del WebSocket
    this.realtimeChannel = channel.subscribe((status, err) => {
      console.log(`[Supabase Realtime] Estado de suscripción: ${status}`);

      if (status === 'SUBSCRIBED') {
        this.reconnectAttempts = 0;
        this.updateStatus('realtime_active', '🟢 En Vivo (Supabase Realtime Activo)');
      } else if (status === 'CHANNEL_ERROR') {
        console.warn('[Supabase Realtime] Error en canal WebSocket:', err);
        this.updateStatus('error', '⚠️ Reconectando Realtime...');
        this.scheduleReconnect();
      } else if (status === 'TIMED_OUT') {
        console.warn('[Supabase Realtime] Timeout en conexión.');
        this.updateStatus('error', '⏳ Tiempo de espera agotado');
        this.scheduleReconnect();
      } else if (status === 'CLOSED') {
        if (navigator.onLine && this.isConfigured()) {
          this.scheduleReconnect();
        }
      }
    });

    return this.realtimeChannel;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(30000, 2000 * Math.pow(1.5, this.reconnectAttempts));
    console.log(`[Supabase Realtime] Programando reconexión en ${Math.round(delay / 1000)}s...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (navigator.onLine && this.isConfigured()) {
        console.log('[Supabase Realtime] Reintentando conexión Realtime...');
        await this.subscribeToAllTables();
      }
    }, delay);
  }

  // ==========================================
  // GUARDIÁN ANTI-PISADO EN TIEMPO REAL
  // ==========================================
  /**
   * Procesa cada mensaje recibido por Supabase Realtime (INSERT / UPDATE / DELETE)
   * aplicando validación de concurrencia y guardando en IndexedDB.
   */
  async handleIncomingRealtimePayload(payload) {
    if (!payload) return;
    const { eventType, table, new: newRecord, old: oldRecord, commit_timestamp } = payload;

    // Deduplicación de eventos recibidos en ráfaga (evita procesar el mismo commit dos veces)
    const recordId = newRecord?.id || oldRecord?.id || newRecord?.key || oldRecord?.key;
    const eventSignature = `${table}:${eventType}:${recordId}:${commit_timestamp || ''}`;
    if (this.recentEventCache.has(eventSignature)) {
      return;
    }
    this.recentEventCache.set(eventSignature, Date.now());
    setTimeout(() => this.recentEventCache.delete(eventSignature), 3000);

    // SUPRESIÓN DE ECO: Si este mismo navegador acaba de enviar este registro en los últimos 7 segundos,
    // ignorar el rebote entrante de Supabase para evitar pisar acciones del usuario (ej. marcar/desmarcar adquirido, archivar)
    const outboundKey = `${table}:${recordId}`;
    const lastOutboundPush = this.recentOutboundPushes.get(outboundKey);
    if (lastOutboundPush && (Date.now() - lastOutboundPush < 7000)) {
      console.log(`[Supabase Realtime] Supresión de eco propio activo para ${outboundKey} (${Date.now() - lastOutboundPush}ms). Se mantiene estado local.`);
      return;
    }

    console.log(`[Supabase Realtime Recibido] [${table}] ${eventType}:`, recordId);

    const storeName = this.mapTableToStore(table);
    if (!storeName) {
      // Si la tabla no corresponde a un store conocido, solo notificar a la app
      this.emitSyncEvent({ table, eventType, record: newRecord || oldRecord });
      return;
    }

    try {
      // 1. MANEJO DE ELIMINACIONES (DELETE)
      if (eventType === 'DELETE') {
        const idToDelete = oldRecord?.id || oldRecord?.key || recordId;
        if (idToDelete) {
          await storageService.delete(storeName, idToDelete);
          console.log(`[Supabase Realtime] Registro ${idToDelete} eliminado en store local ${storeName}`);
          this.emitSyncEvent({ table, eventType: 'DELETE', record: { id: idToDelete } });
        }
        return;
      }

      // 2. MANEJO DE INSERCIONES Y ACTUALIZACIONES (INSERT / UPDATE)
      if (eventType === 'INSERT' || eventType === 'UPDATE') {
        if (!newRecord) return;

        // Caso especial: settings (se maneja por 'key')
        if (storeName === 'settings') {
          const key = newRecord.key || 'app_config';
          const localSettings = await storageService.getById('settings', key);
          if (localSettings) {
            const localTime = new Date(localSettings.updatedAt || 0).getTime();
            const remoteTime = new Date(newRecord.updatedAt || 0).getTime();
            if (localTime > remoteTime) {
              console.warn(`[Guardián Anti-Pisado] Ajustes locales más recientes que la nube. Se preserva local.`);
              this.pushRecord('settings', localSettings).catch(console.error);
              return;
            }
          }
          await storageService.put('settings', newRecord);
          this.emitSyncEvent({ table, eventType, record: newRecord });
          return;
        }

        // Resto de entidades con primary key 'id'
        const currentLocal = await storageService.getById(storeName, newRecord.id);

        if (currentLocal) {
          const localTime = new Date(currentLocal.updatedAt || currentLocal.createdAt || 0).getTime();
          const remoteTime = new Date(newRecord.updatedAt || newRecord.createdAt || 0).getTime();

          // Si es un encargo, fusionar abonos bidireccionalmente para no perder ningún pago registrado en otro equipo
          if (storeName === 'orders') {
            this.mergeOrderAbonos(currentLocal, newRecord);
          }

          // ¡ALERTA ANTI-PISADO! Si el registro local es estrictamente más reciente que el remoto o igual:
          // Se protege la versión local para no pisar cambios locales recientes
          if (localTime >= remoteTime) {
            console.warn(`[Guardián Anti-Pisado] Registro local ${newRecord.id} (${new Date(localTime).toISOString()}) >= nube (${new Date(remoteTime).toISOString()}). Protegiendo local.`);
            return;
          }
        }

        // El registro remoto es nuevo o más reciente: Guardar en IndexedDB preservando propiedades locales
        let recordToSave = newRecord;
        if (currentLocal) {
          recordToSave = { ...currentLocal, ...newRecord };
          if (storeName === 'orders') {
            // Protección explícita para adquirido: si el remoto viene sin la columna o null
            if (newRecord.adquirido === undefined || newRecord.adquirido === null) {
              recordToSave.adquirido = Boolean(currentLocal.adquirido);
            }
            // Protección explícita para archivado: no permitir que un remoto sin columna desarchive un pedido local
            if (newRecord.archivado === undefined || newRecord.archivado === null) {
              recordToSave.archivado = Boolean(currentLocal.archivado);
            } else if (currentLocal.archivado && !newRecord.archivado) {
              const localArchTime = new Date(currentLocal.fechaArchivado || currentLocal.updatedAt || 0).getTime();
              const remoteArchTime = new Date(newRecord.fechaArchivado || 0).getTime();
              if (localArchTime >= remoteArchTime) {
                recordToSave.archivado = true;
                recordToSave.fechaArchivado = currentLocal.fechaArchivado;
              }
            }
            if (newRecord.entregado === undefined || newRecord.entregado === null) {
              recordToSave.entregado = Boolean(currentLocal.entregado);
            }
          }
        }
        await storageService.put(storeName, recordToSave);
        this.emitSyncEvent({ table, eventType, record: recordToSave });
      }
    } catch (err) {
      console.error(`[Supabase Realtime] Error al procesar evento en ${table}:`, err);
    }
  }

  // ==========================================
  // MANEJO INTELIGENTE DE COLUMNAS & ESQUEMA
  // ==========================================
  getUnsupportedColumns(table) {
    if (!this.unsupportedColumns) {
      this.loadUnsupportedColumns();
    }
    return this.unsupportedColumns[table] || new Set();
  }

  loadUnsupportedColumns() {
    this.unsupportedColumns = {
      orders: new Set(),
      destinations: new Set(),
      customers: new Set(),
      users: new Set(),
      settings: new Set()
    };
    // Limpiar caché obsoleto de localStorage para permitir que columnas recién creadas se envíen
    try {
      localStorage.removeItem(UNSUPPORTED_COLUMNS_KEY);
    } catch (e) {}
  }

  saveUnsupportedColumns() {
    // Mantener solo en memoria durante la sesión sin ensuciar localStorage
  }

  markColumnUnsupported(table, column) {
    if (!this.unsupportedColumns) this.loadUnsupportedColumns();
    if (!this.unsupportedColumns[table]) this.unsupportedColumns[table] = new Set();
    this.unsupportedColumns[table].add(column);
  }

  clearUnsupportedColumns() {
    this.unsupportedColumns = {
      orders: new Set(),
      destinations: new Set(),
      customers: new Set(),
      users: new Set(),
      settings: new Set()
    };
    try {
      localStorage.removeItem(UNSUPPORTED_COLUMNS_KEY);
    } catch (e) {}
  }

  preparePayload(table, record) {
    if (!record || typeof record !== 'object') return record;
    const payload = { ...record };
    const unsupported = this.getUnsupportedColumns(table);
    for (const col of unsupported) {
      delete payload[col];
    }
    return payload;
  }

  /**
   * Ejecuta un upsert seguro en Supabase. Si una columna aún no existe en la base de datos (PGRST204),
   * la detecta, la excluye dinámicamente y reintenta de inmediato para que ningún abono ni pedido se bloquee.
   */
  async executeUpsert(table, record) {
    if (!this.client) throw new Error('Cliente Supabase no inicializado');
    const conflictField = table === 'settings' ? 'key' : 'id';
    let payload = this.preparePayload(table, record);

    let retryCount = 0;
    while (retryCount < 10) {
      const { data, error } = await this.client
        .from(table)
        .upsert(payload, { onConflict: conflictField });

      if (!error) {
        return { success: true, data };
      }

      // Detectar columna no existente en el esquema de Supabase (PGRST204)
      if (error.code === 'PGRST204' || (error.message && error.message.toLowerCase().includes('schema cache'))) {
        const colMatch = error.message.match(/Could not find the '([^']+)' column/i);
        if (colMatch && colMatch[1]) {
          const badCol = colMatch[1];
          console.warn(`[SupabaseService] Columna "${badCol}" no existe en la tabla "${table}" de Supabase. Omitiendo dinámicamente y reintentando...`);
          this.markColumnUnsupported(table, badCol);
          delete payload[badCol];
          retryCount++;
          continue;
        }
      }

      return { success: false, error };
    }

    return { success: false, error: new Error(`No se pudo guardar en ${table} tras reintentos`) };
  }

  /**
   * Unifica historiales de abonos entre la base local y remota sin perder ningún pago registrado en otro equipo
   */
  mergeOrderAbonos(localOrder, incomingOrder) {
    if (!localOrder || !incomingOrder) return;
    const abonosMap = new Map();
    (localOrder.historialAbonos || []).forEach(a => {
      if (a && a.id) abonosMap.set(a.id, a);
    });
    (incomingOrder.historialAbonos || []).forEach(a => {
      if (a && a.id) abonosMap.set(a.id, a);
    });
    const mergedAbonos = Array.from(abonosMap.values());
    mergedAbonos.sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0));

    const totalAbonado = Math.round(mergedAbonos.reduce((sum, a) => sum + (Number(a.monto) || 0), 0) * 100) / 100;
    const costoTotal = Number(incomingOrder.costoTotal !== undefined ? incomingOrder.costoTotal : localOrder.costoTotal) || 0;
    const saldoPendiente = Math.max(0, Math.round((costoTotal - totalAbonado) * 100) / 100);

    incomingOrder.historialAbonos = mergedAbonos;
    incomingOrder.totalAbonado = totalAbonado;
    incomingOrder.saldoPendiente = saldoPendiente;
    incomingOrder.porcentajePagado = costoTotal > 0 ? Math.min(100, Math.round((totalAbonado / costoTotal) * 100)) : 100;
  }

  // ==========================================
  // SINCRONIZACIÓN DE SALIDA (OUTBOUND PUSH)
  // ==========================================
  /**
   * Sube o actualiza un registro directamente en Supabase con tolerancia a columnas faltantes.
   * Si está offline o falla la red, lo encola automáticamente en la Offline Queue.
   *
   * @param {string} table - Nombre de la tabla
   * @param {Object} record - Objeto a guardar
   */
  async pushRecord(table, record) {
    if (!record) return { skipped: true };

    const recId = record?.id || record?.key;
    if (recId) {
      this.recentOutboundPushes.set(`${table}:${recId}`, Date.now());
      setTimeout(() => this.recentOutboundPushes.delete(`${table}:${recId}`), 8000);
    }

    if (!this.client || !navigator.onLine) {
      this.enqueueOfflineAction({ table, action: 'upsert', record });
      return { queued: true };
    }

    try {
      const res = await this.executeUpsert(table, record);
      if (!res.success) {
        console.warn(`[SupabaseService] Error en upsert para ${table}:`, res.error?.message || res.error);
        this.enqueueOfflineAction({ table, action: 'upsert', record });
        return { success: false, error: res.error?.message || res.error };
      }

      return { success: true };
    } catch (err) {
      console.warn(`[SupabaseService] Error de red al enviar a ${table}:`, err.message);
      this.enqueueOfflineAction({ table, action: 'upsert', record });
      return { success: false, error: err.message };
    }
  }

  /**
   * Elimina un registro en Supabase.
   * Si está offline, lo encola para ejecución diferida.
   */
  async pushDelete(table, id) {
    if (!id) return { skipped: true };

    if (!this.client || !navigator.onLine) {
      this.enqueueOfflineAction({ table, action: 'delete', id });
      return { queued: true };
    }

    try {
      const keyField = table === 'settings' ? 'key' : 'id';
      const { error } = await this.client
        .from(table)
        .delete()
        .eq(keyField, id);

      if (error) {
        console.warn(`[SupabaseService] Error en delete para ${table}:`, error.message);
        this.enqueueOfflineAction({ table, action: 'delete', id });
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (err) {
      console.warn(`[SupabaseService] Error de red en delete ${table}:`, err.message);
      this.enqueueOfflineAction({ table, action: 'delete', id });
      return { success: false, error: err.message };
    }
  }

  // ==========================================
  // MANEJO DE COLA OFFLINE (OFFLINE QUEUE)
  // ==========================================
  getOfflineQueue() {
    try {
      const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  saveOfflineQueue(queue) {
    try {
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
      console.error('[SupabaseService] Error guardando cola offline:', e);
    }
  }

  enqueueOfflineAction(actionItem) {
    const queue = this.getOfflineQueue();
    actionItem.timestamp = Date.now();
    queue.push(actionItem);
    this.saveOfflineQueue(queue);
    console.log(`[SupabaseService] Acción encolada en cola offline (${queue.length} pendientes).`);
  }

  /**
   * Deduplica la cola offline por tabla y ID para evitar saturación innecesaria
   */
  deduplicateQueue(queue) {
    const map = new Map();
    for (const item of queue) {
      if (!item) continue;
      const recId = item.record?.id || item.record?.key || item.id;
      const key = `${item.table}:${item.action}:${recId}`;
      map.set(key, item);
    }
    return Array.from(map.values());
  }

  /**
   * Procesa y vacía la cola offline enviando todas las operaciones pendientes a Supabase.
   */
  async flushOfflineQueue() {
    if (this.isFlushingQueue || !this.client || !navigator.onLine) return;
    const rawQueue = this.getOfflineQueue();
    if (rawQueue.length === 0) return;

    this.isFlushingQueue = true;
    const queue = this.deduplicateQueue(rawQueue);
    console.log(`[SupabaseService] Procesando cola offline: ${queue.length} operaciones únicas (reducidas de ${rawQueue.length})...`);

    const remainingQueue = [];

    for (const item of queue) {
      try {
        if (item.action === 'upsert') {
          const res = await this.executeUpsert(item.table, item.record);
          if (!res.success) throw (res.error || new Error('Upsert fallido'));
        } else if (item.action === 'delete') {
          const keyField = item.table === 'settings' ? 'key' : 'id';
          const { error } = await this.client
            .from(item.table)
            .delete()
            .eq(keyField, item.id);
          if (error) throw error;
        }
      } catch (err) {
        console.warn(`[SupabaseService] Falló reintento de acción offline en ${item.table}:`, err.message || err);
        remainingQueue.push(item);
      }
    }

    this.saveOfflineQueue(remainingQueue);
    this.isFlushingQueue = false;

    if (remainingQueue.length === 0) {
      console.log('[SupabaseService] Cola offline vaciada y sincronizada exitosamente.');
    } else {
      console.warn(`[SupabaseService] Quedan ${remainingQueue.length} elementos pendientes en la cola.`);
    }
  }

  // ==========================================
  // SINCRONIZACIÓN COMPLETA (PULL & MERGE)
  // ==========================================
  /**
   * Descarga todos los registros de cada tabla en Supabase y realiza una fusión
   * protegida con IndexedDB utilizando el guardián anti-colisión.
   */
  async syncAll() {
    if (!navigator.onLine) {
      this.updateStatus('offline', 'Modo Offline: Usando última base local');
      return { success: true, offline: true };
    }

    if (!this.client) {
      const initialized = await this.initFromSettings();
      if (!initialized) {
        this.updateStatus('unconfigured', 'Supabase no configurado');
        return { success: false, unconfigured: true };
      }
    }

    this.updateStatus('syncing', 'Sincronizando con Supabase...');

    let totalConflictsPrevented = 0;
    let totalUpdated = 0;
    let totalAdded = 0;

    try {
      for (const table of SYNC_TABLES) {
        const storeName = this.mapTableToStore(table);
        if (!storeName) continue;

        // 1. Descargar todos los registros remotos
        const { data: remoteRecords, error } = await this.client
          .from(table)
          .select('*');

        if (error) {
          // Si la tabla no existe en Supabase aún, informarlo sin romper la app
          if (error.code === '42P01') {
            console.warn(`[SupabaseService] La tabla "${table}" no existe aún en Supabase. Ejecuta el script SQL de configuración.`);
            continue;
          }
          throw error;
        }

        if (table === 'settings') {
          // Manejo para settings
          if (remoteRecords && remoteRecords.length > 0) {
            for (const item of remoteRecords) {
              const local = await storageService.getById('settings', item.key);
              if (!local) {
                await storageService.put('settings', item);
              } else {
                const localTime = new Date(local.updatedAt || 0).getTime();
                const remoteTime = new Date(item.updatedAt || 0).getTime();
                if (remoteTime > localTime) {
                  await storageService.put('settings', item);
                } else if (localTime > remoteTime) {
                  await this.pushRecord('settings', local);
                }
              }
            }
          }
          continue;
        }

        // 2. Fusión segura con IndexedDB
        const localRecords = await storageService.getAll(storeName);
        const mergeResult = this.mergeDataset(localRecords, remoteRecords || []);

        totalConflictsPrevented += mergeResult.conflictsPrevented;
        totalUpdated += mergeResult.updatedCount;
        totalAdded += mergeResult.addedCount;

        // Guardar la versión unificada en IndexedDB
        for (const item of mergeResult.mergedItems) {
          await storageService.put(storeName, item);
        }

        // 3. Subir a Supabase registros locales que no existían en la nube o eran más nuevos
        for (const localItem of localRecords) {
          const remoteMatch = (remoteRecords || []).find(r => r.id === localItem.id);
          if (!remoteMatch) {
            // No estaba en la nube: subirlo
            await this.pushRecord(table, localItem);
          } else {
            const localTime = new Date(localItem.updatedAt || localItem.createdAt || 0).getTime();
            const remoteTime = new Date(remoteMatch.updatedAt || remoteMatch.createdAt || 0).getTime();
            if (localTime > remoteTime) {
              await this.pushRecord(table, localItem);
            }
          }
        }
      }

      // Procesar cualquier cambio pendiente en cola
      await this.flushOfflineQueue();

      this.updateStatus('realtime_active', '🟢 En Vivo (Sincronizado con Supabase)');

      return {
        success: true,
        conflictsPrevented: totalConflictsPrevented,
        updatedCount: totalUpdated,
        addedCount: totalAdded
      };
    } catch (err) {
      console.error('[SupabaseService] Error durante sincronización completa:', err);
      this.updateStatus('error', `Error al sincronizar: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Algoritmo de comparación registro por registro basado en fechas (Guardián Anti-Pisado)
   */
  mergeDataset(localItems = [], incomingItems = []) {
    const localMap = new Map();
    localItems.forEach(item => localMap.set(item.id, item));

    let conflictsPrevented = 0;
    let updatedCount = 0;
    let addedCount = 0;

    incomingItems.forEach(incoming => {
      if (!incoming || !incoming.id) return;
      const local = localMap.get(incoming.id);

      if (!local) {
        localMap.set(incoming.id, incoming);
        addedCount++;
      } else {
        const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
        const incomingTime = new Date(incoming.updatedAt || incoming.createdAt || 0).getTime();

        if (incomingTime > localTime) {
          if (incoming.historialAbonos && local.historialAbonos) {
            this.mergeOrderAbonos(local, incoming);
          }
          // Fusionar preservando campos locales si el remoto no los tuviese aún (o viniesen null/undefined)
          const merged = { ...local, ...incoming };
          if (incoming.adquirido === undefined || incoming.adquirido === null) {
            merged.adquirido = Boolean(local.adquirido);
          }
          if (incoming.archivado === undefined || incoming.archivado === null) {
            merged.archivado = Boolean(local.archivado);
          } else if (local.archivado && !incoming.archivado) {
            const localArchTime = new Date(local.fechaArchivado || local.updatedAt || 0).getTime();
            const remoteArchTime = new Date(incoming.fechaArchivado || 0).getTime();
            if (localArchTime >= remoteArchTime) {
              merged.archivado = true;
              merged.fechaArchivado = local.fechaArchivado;
            }
          }
          if (incoming.entregado === undefined || incoming.entregado === null) {
            merged.entregado = Boolean(local.entregado);
          }
          localMap.set(incoming.id, merged);
          updatedCount++;
        } else if (localTime >= incomingTime) {
          if (local.historialAbonos && incoming.historialAbonos) {
            this.mergeOrderAbonos(incoming, local);
          }
          conflictsPrevented++;
          console.warn(`[Guardián Anti-Pisado] Registro local ${local.id} preservado (Local: ${new Date(localTime).toISOString()} >= Nube: ${new Date(incomingTime).toISOString()})`);
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

  // ==========================================
  // DIAGNÓSTICO Y PROBADOR DE CONEXIÓN
  // ==========================================
  /**
   * Realiza una prueba exhaustiva de conexión con Supabase REST y Realtime
   */
  async testConnection(url, anonKey) {
    if (!url || !anonKey) {
      return { success: false, message: 'Ingresa la URL y la Anon Key de Supabase.' };
    }

    let cleanUrl = url.trim().replace(/\/+$/, '');
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    const cleanKey = anonKey.trim();

    try {
      // 1. Probar Endpoint REST con API Key
      const restRes = await fetch(`${cleanUrl}/rest/v1/`, {
        headers: {
          'apikey': cleanKey,
          'Authorization': `Bearer ${cleanKey}`
        }
      });

      if (!restRes.ok && restRes.status !== 404 && restRes.status !== 200) {
        return {
          success: false,
          message: `Respuesta del servidor Supabase: HTTP ${restRes.status} ${restRes.statusText}`
        };
      }

      // 2. Verificar el SDK y acceso a tablas
      const sdk = await this.getSDK();
      const testClient = sdk.createClient(cleanUrl, cleanKey);

      // Consulta de prueba a la tabla 'orders'
      const { data, error } = await testClient
        .from('orders')
        .select('id')
        .limit(1);

      if (error) {
        if (error.code === '42P01') {
          return {
            success: true,
            warning: true,
            message: '¡Conexión establecida con Supabase! ⚠️ Las tablas aún no han sido creadas. Utiliza el botón "Ver Script SQL para Supabase" para crearlas en 1 clic.'
          };
        }
        return {
          success: false,
          message: `Conectó pero hubo un error de permisos/RLS: ${error.message}`
        };
      }

      // Verificar si las columnas recientes existen en el esquema de Supabase
      const testSchemaRes = await testClient.from('orders').select('id, adquirido').limit(1);
      if (testSchemaRes.error && (testSchemaRes.error.code === 'PGRST204' || testSchemaRes.error.message?.includes('schema cache'))) {
        this.markColumnUnsupported('orders', 'adquirido');
        return {
          success: true,
          warning: true,
          message: '¡Conexión establecida con Supabase! ⚠️ Faltan columnas recientes (como "adquirido"). El sistema seguirá sincronizando automáticamente omitiendo campos incompatibles, pero para sincronizar entregas y estados completos se recomienda ejecutar el script SQL en Supabase.'
        };
      }

      // Si funcionó con éxito, limpiar columnas no soportadas para esta tabla
      this.clearUnsupportedColumns();

      return {
        success: true,
        message: '¡Conexión exitosa con Supabase! Tablas y todas las columnas verificadas al 100%.'
      };
    } catch (err) {
      return {
        success: false,
        message: `Fallo de conexión: ${err.message}. Verifica que la URL y Anon Key sean correctas.`
      };
    }
  }

  // ==========================================
  // SCRIPT SQL DE INICIALIZACIÓN PARA SUPABASE
  // ==========================================
  /**
   * Genera el script SQL de creación de tablas, políticas RLS y Realtime
   * listo para copiar y pegar en el SQL Editor de Supabase.
   */
  getSetupSQL() {
    return `-- ============================================================
-- SCRIPT DE INICIALIZACIÓN: SISTEMA DE ENCARGOS Y APARTADOS
-- Compatible con Supabase PostgreSQL + Realtime Replication
-- ============================================================

-- 0. ACTUALIZACIÓN INMEDIATA DE COLUMNAS (Para tablas que ya existen)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "adquirido" BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "fechaAdquisicion" TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "entregado" BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "fechaEntregaReal" TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "archivado" BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "fechaArchivado" TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "fechaLiquidacion" TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "clienteEmail" TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "numeroSeguimiento" TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now());
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "categoria" TEXT DEFAULT 'Terminal';
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "mapsUrl" TEXT;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "lat" NUMERIC;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "lng" NUMERIC;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "notas" TEXT;
NOTIFY pgrst, 'reload schema';

-- 1. TABLA: Clientes (customers)
CREATE TABLE IF NOT EXISTS public.customers (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    telefono TEXT,
    email TEXT,
    "documentoIdentidad" TEXT,
    "ciudadDefault" TEXT,
    "direccionDefault" TEXT,
    "saldoFavor" NUMERIC DEFAULT 0,
    notas TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    "updatedAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 2. TABLA: Encargos y Apartados (orders)
CREATE TABLE IF NOT EXISTS public.orders (
    id TEXT PRIMARY KEY,
    "clienteId" TEXT,
    "clienteNombre" TEXT,
    "clienteTelefono" TEXT,
    "clienteEmail" TEXT,
    "numeroSeguimiento" TEXT,
    modalidad TEXT,
    "fechaCreacion" TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    "fechaEntregaEstimada" TEXT,
    "lugarDestino" JSONB,
    items JSONB DEFAULT '[]'::jsonb,
    "costoItems" NUMERIC DEFAULT 0,
    "costoEnvioComision" NUMERIC DEFAULT 0,
    "costoTotal" NUMERIC DEFAULT 0,
    "anticipoExigidoTipo" TEXT DEFAULT 'porcentaje',
    "anticipoExigidoValor" NUMERIC DEFAULT 50,
    "montoAnticipoCalculado" NUMERIC DEFAULT 0,
    "historialAbonos" JSONB DEFAULT '[]'::jsonb,
    "totalAbonado" NUMERIC DEFAULT 0,
    "saldoPendiente" NUMERIC DEFAULT 0,
    "porcentajePagado" NUMERIC DEFAULT 0,
    estado TEXT DEFAULT 'pendiente_anticipo',
    adquirido BOOLEAN DEFAULT false,
    "fechaAdquisicion" TIMESTAMPTZ,
    entregado BOOLEAN DEFAULT false,
    "fechaEntregaReal" TIMESTAMPTZ,
    archivado BOOLEAN DEFAULT false,
    "fechaLiquidacion" TIMESTAMPTZ,
    "notasInternas" TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    "updatedAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 3. TABLA: Catálogo de Destinos y Rutas (destinations)
CREATE TABLE IF NOT EXISTS public.destinations (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    ciudad TEXT,
    tipo TEXT,
    categoria TEXT DEFAULT 'Terminal',
    direccion TEXT,
    referencia TEXT,
    "enlaceMaps" TEXT,
    "mapsUrl" TEXT,
    lat NUMERIC,
    lng NUMERIC,
    notas TEXT,
    coords JSONB,
    "updatedAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    "createdAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 4. TABLA: Usuarios y Roles por Cargo (users)
CREATE TABLE IF NOT EXISTS public.users (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    usuario TEXT,
    password TEXT DEFAULT '1234',
    rol TEXT NOT NULL,
    telefono TEXT,
    email TEXT,
    "cargoTitulo" TEXT,
    avatar TEXT,
    "updatedAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    "createdAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 5. TABLA: Configuración del Sistema (settings)
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- ============================================================
-- MIGRACIÓN / ACTUALIZACIÓN AUTOMÁTICA DE COLUMNAS NUEVAS
-- (Si ya creaste las tablas antes, estas líneas añaden columnas faltantes sin borrar datos)
-- ============================================================
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "adquirido" BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "fechaAdquisicion" TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "entregado" BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "fechaEntregaReal" TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "archivado" BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "fechaArchivado" TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "clienteEmail" TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "numeroSeguimiento" TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ DEFAULT timezone('utc'::text, now());

ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "categoria" TEXT DEFAULT 'Terminal';
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "mapsUrl" TEXT;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "lat" NUMERIC;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "lng" NUMERIC;
ALTER TABLE public.destinations ADD COLUMN IF NOT EXISTS "notas" TEXT;

-- Recargar caché del esquema en Supabase PostgREST
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- SEGURIDAD: ROW LEVEL SECURITY (RLS)
-- Permitir acceso completo a la PWA con la clave pública (anon)
-- ============================================================
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Acceso total anon customers') THEN
    CREATE POLICY "Acceso total anon customers" ON public.customers FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Acceso total anon orders') THEN
    CREATE POLICY "Acceso total anon orders" ON public.orders FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Acceso total anon destinations') THEN
    CREATE POLICY "Acceso total anon destinations" ON public.destinations FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Acceso total anon users') THEN
    CREATE POLICY "Acceso total anon users" ON public.users FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Acceso total anon settings') THEN
    CREATE POLICY "Acceso total anon settings" ON public.settings FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ============================================================
-- REPLICACIÓN COMPLETA PARA TIEMPO REAL (REPLICA IDENTITY FULL)
-- Asegura que Supabase Realtime envíe todos los campos en UPDATE / DELETE
-- ============================================================
ALTER TABLE public.customers REPLICA IDENTITY FULL;
ALTER TABLE public.orders REPLICA IDENTITY FULL;
ALTER TABLE public.destinations REPLICA IDENTITY FULL;
ALTER TABLE public.users REPLICA IDENTITY FULL;
ALTER TABLE public.settings REPLICA IDENTITY FULL;

-- ============================================================
-- HABILITAR REALTIME EN LA PUBLICACIÓN DE SUPABASE
-- ============================================================
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customers;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.destinations;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.settings;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
`;
  }

  // ==========================================
  // EVENTOS Y OBSERVADORES REACTIVOS
  // ==========================================
  mapTableToStore(table) {
    const map = {
      customers: 'customers',
      orders: 'orders',
      destinations: 'destinations',
      users: 'users',
      settings: 'settings'
    };
    return map[table] || null;
  }

  onStatusChange(callback) {
    this.listeners.push(callback);
    callback(this.status, this.statusMessage);
  }

  updateStatus(status, message) {
    this.status = status;
    this.statusMessage = message;
    this.listeners.forEach((cb) => {
      try { cb(status, message); } catch (e) { console.error(e); }
    });
  }

  onSyncEvent(callback) {
    this.syncEventListeners.push(callback);
  }

  emitSyncEvent(eventDetail) {
    this.syncEventListeners.forEach((cb) => {
      try { cb(eventDetail); } catch (e) { console.error(e); }
    });

    // También emitir evento nativo del DOM para observadores externos
    window.dispatchEvent(new CustomEvent('supabase:change', { detail: eventDetail }));
  }

  initNetworkListeners() {
    window.addEventListener('online', async () => {
      console.log('[SupabaseService] Red reanudada: Conectando Realtime y vaciando cola offline...');
      if (this.isConfigured()) {
        this.updateStatus('syncing', 'Conexión restaurada: Sincronizando...');
        await this.subscribeToAllTables();
        await this.flushOfflineQueue();
        this.updateStatus('realtime_active', '🟢 En Vivo (Realtime Activo)');
      }
    });

    window.addEventListener('offline', () => {
      console.log('[SupabaseService] Red perdida: Pasando a modo Offline.');
      this.updateStatus('offline', 'Modo Offline (Trabajando localmente)');
    });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.realtimeChannel && this.client) {
      this.client.removeChannel(this.realtimeChannel).catch(() => {});
      this.realtimeChannel = null;
    }
    this.client = null;
  }
}

export const supabaseService = new SupabaseService();
