/**
 * StorageService - DeepSeek Harness Provider
 * Almacenamiento Offline-First utilizando IndexedDB nativo con fallback automático.
 */

const DB_NAME = 'SistemaEncargosDB';
const DB_VERSION = 2;

class StorageService {
  constructor() {
    this.db = null;
    this.readyPromise = this.init();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Store de Clientes
        if (!db.objectStoreNames.contains('customers')) {
          const customerStore = db.createObjectStore('customers', { keyPath: 'id' });
          customerStore.createIndex('nombre', 'nombre', { unique: false });
          customerStore.createIndex('telefono', 'telefono', { unique: false });
        }

        // Store de Encargos / Apartados
        if (!db.objectStoreNames.contains('orders')) {
          const orderStore = db.createObjectStore('orders', { keyPath: 'id' });
          orderStore.createIndex('clienteId', 'clienteId', { unique: false });
          orderStore.createIndex('estado', 'estado', { unique: false });
          orderStore.createIndex('ciudad', 'lugarDestino.ciudad', { unique: false });
          orderStore.createIndex('fechaEntrega', 'fechaEntregaEstimada', { unique: false });
        }

        // Store de Configuración
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        // Store de Destinos / Ubicaciones Frecuentes
        if (!db.objectStoreNames.contains('destinations')) {
          const destStore = db.createObjectStore('destinations', { keyPath: 'id' });
          destStore.createIndex('ciudad', 'ciudad', { unique: false });
          destStore.createIndex('nombre', 'nombre', { unique: false });
        }

        // Store de Usuarios por Cargo (Administrador, Despachador)
        if (!db.objectStoreNames.contains('users')) {
          const userStore = db.createObjectStore('users', { keyPath: 'id' });
          userStore.createIndex('rol', 'rol', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('Error al abrir IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  async ready() {
    return this.readyPromise;
  }

  // Operaciones genéricas
  async getAll(storeName) {
    await this.ready();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getById(storeName, id) {
    await this.ready();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async put(storeName, item) {
    await this.ready();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(item);

      request.onsuccess = () => resolve(item);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(storeName, id) {
    await this.ready();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(id);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  // Métodos específicos para configuración
  async getSettings() {
    await this.ready();
    const result = await this.getById('settings', 'app_config');
    if (result && result.value) {
      if (result.value.empresa && !result.value.empresa.prefijoPais) {
        result.value.empresa.prefijoPais = '+58';
      }
      return result.value;
    }
    // Configuración por defecto
    const defaultSettings = {
      empresa: {
        nombre: 'Encargos & Apartados Express',
        propietario: 'Administrador',
        telefono: '+58 414 0000000',
        email: 'contacto@encargosexpress.com',
        moneda: '$',
        anticipoDefault: 50,
        prefijoPais: '+58',
        mensajeTicket: '¡Gracias por su preferencia! Los abonos garantizan el apartado de su mercancía.'
      },
      cloud: {
        provider: 'none', // 'none' | 'supabase' | 'firebase'
        supabaseUrl: '',
        supabaseAnonKey: '',
        firebaseConfig: ''
      }
    };
    await this.saveSettings(defaultSettings);
    return defaultSettings;
  }

  async saveSettings(settings) {
    return this.put('settings', { key: 'app_config', value: settings, updatedAt: new Date().toISOString() });
  }

  // Exportar toda la base de datos a un JSON
  async exportDatabase() {
    await this.ready();
    const customers = await this.getAll('customers');
    const orders = await this.getAll('orders');
    const destinations = await this.getAll('destinations');
    const users = await this.getAll('users');
    const settings = await this.getSettings();

    return {
      appName: 'SistemaEncargosProductos',
      version: '1.3.0',
      exportedAt: new Date().toISOString(),
      data: {
        customers,
        orders,
        destinations,
        users,
        settings
      }
    };
  }

  // Importar y reemplazar datos desde un JSON
  async importDatabase(jsonData) {
    await this.ready();
    if (!jsonData || !jsonData.data) {
      throw new Error('Formato de respaldo inválido.');
    }

    const { customers = [], orders = [], destinations = [], users = [], settings } = jsonData.data;

    // Guardar clientes
    for (const c of customers) {
      await this.put('customers', c);
    }

    // Guardar pedidos
    for (const o of orders) {
      await this.put('orders', o);
    }

    // Guardar destinos
    for (const d of destinations) {
      await this.put('destinations', d);
    }

    // Guardar usuarios
    for (const u of users) {
      await this.put('users', u);
    }

    // Guardar configuración si existe
    if (settings) {
      await this.saveSettings(settings);
    }

    return true;
  }
}

export const storageService = new StorageService();
