/**
 * AuthService - DeepSeek Harness Provider
 * Autenticación con Usuario y Contraseña, Jerarquía de Roles y Control de Permisos.
 */

import { storageService } from './storage.service.js';
import { supabaseService } from './supabase.service.js';

export const ROLES = {
  ADMIN: 'admin',
  DISPATCHER: 'dispatcher'
};

export const PERMISSIONS = {
  VIEW_ORDERS: 'view_orders',
  CREATE_ORDER: 'create_order',
  ADD_PAYMENT: 'add_payment',
  SETTLE_ORDER: 'settle_order',
  CHANGE_ORDER_STATUS: 'change_order_status',
  PRINT_TICKETS: 'print_tickets',
  SEND_NOTIFICATIONS: 'send_notifications',
  VIEW_DESTINATIONS: 'view_destinations',
  MANAGE_DESTINATIONS: 'manage_destinations',
  VIEW_CUSTOMERS: 'view_customers',
  MANAGE_CUSTOMERS: 'manage_customers',
  MANAGE_SETTINGS: 'manage_settings',
  MANAGE_USERS: 'manage_users',
  DATABASE_BACKUP_RESTORE: 'database_backup_restore'
};

const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: Object.values(PERMISSIONS), // Acceso total
  [ROLES.DISPATCHER]: [
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.CREATE_ORDER,
    PERMISSIONS.ADD_PAYMENT,
    PERMISSIONS.CHANGE_ORDER_STATUS,
    PERMISSIONS.PRINT_TICKETS,
    PERMISSIONS.SEND_NOTIFICATIONS,
    PERMISSIONS.VIEW_DESTINATIONS,
    PERMISSIONS.MANAGE_DESTINATIONS,
    PERMISSIONS.VIEW_CUSTOMERS
  ]
};

const AUTH_STORAGE_KEY = 'encargos_active_session_id_v2';
const DISPATCHER_SIMULATION_KEY = 'encargos_admin_dispatcher_simulation';

class AuthService {
  constructor() {
    this.currentUser = null;
    this.simulatedDispatcherMode = false;
    this.userChangeListeners = [];
  }

  async init() {
    await this.seedDefaultUsersIfEmpty();

    const savedSessionId = localStorage.getItem(AUTH_STORAGE_KEY);
    this.simulatedDispatcherMode = localStorage.getItem(DISPATCHER_SIMULATION_KEY) === 'true';

    if (savedSessionId) {
      const users = await this.getAllUsers();
      this.currentUser = users.find(u => u.id === savedSessionId) || null;
    } else {
      this.currentUser = null;
    }

    return this.currentUser;
  }

  onUserChange(callback) {
    this.userChangeListeners.push(callback);
    callback(this.currentUser);
  }

  notifyUserChange() {
    this.userChangeListeners.forEach(cb => {
      try { cb(this.currentUser); } catch (e) { console.error(e); }
    });
  }

  isAuthenticated() {
    return !!this.currentUser;
  }

  getCurrentUser() {
    return this.currentUser;
  }

  /**
   * Indica si el usuario actual opera como Administrador.
   * Si un administrador activó temporalmente el modo ruta / despachador, retorna false.
   */
  isAdmin() {
    if (!this.currentUser) return false;
    if (this.simulatedDispatcherMode) return false;
    return this.currentUser.rol === ROLES.ADMIN;
  }

  /**
   * Indica si la sesión actual tiene permisos de Despachador (operativo).
   */
  isDispatcher() {
    if (!this.currentUser) return false;
    if (this.simulatedDispatcherMode) return true;
    return this.currentUser.rol === ROLES.DISPATCHER;
  }

  /**
   * Si es un administrador, permite alternar a Modo Ruta (Despachador) para operar en entregas
   */
  toggleAdminDispatcherSimulation() {
    if (this.currentUser?.rol !== ROLES.ADMIN) return false;
    this.simulatedDispatcherMode = !this.simulatedDispatcherMode;
    localStorage.setItem(DISPATCHER_SIMULATION_KEY, String(this.simulatedDispatcherMode));
    this.notifyUserChange();
    return this.simulatedDispatcherMode;
  }

  isSimulatedDispatcher() {
    return this.simulatedDispatcherMode && this.currentUser?.rol === ROLES.ADMIN;
  }

  can(permission) {
    if (!this.currentUser) return false;
    const currentEffectiveRole = this.isAdmin() ? ROLES.ADMIN : ROLES.DISPATCHER;
    const allowed = ROLE_PERMISSIONS[currentEffectiveRole] || [];
    return allowed.includes(permission);
  }

  async getAllUsers() {
    await storageService.ready();
    const users = await storageService.getAll('users');
    return users.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  }

  /**
   * Inicia sesión con usuario/correo y contraseña
   */
  async login(identifier, password) {
    const cleanId = (identifier || '').trim().toLowerCase();
    const cleanPass = (password || '').trim();

    if (!cleanId || !cleanPass) {
      return { success: false, message: 'Ingresa tu usuario y contraseña.' };
    }

    const users = await this.getAllUsers();
    const user = users.find(u => 
      (u.usuario && u.usuario.toLowerCase() === cleanId) || 
      (u.email && u.email.toLowerCase() === cleanId)
    );

    if (!user) {
      return { success: false, message: 'Usuario no encontrado en la base de datos.' };
    }

    // Verificar contraseña (con fallback a contraseña por defecto si se creó sin clave)
    const validPass = user.password || '1234';
    if (cleanPass !== validPass) {
      return { success: false, message: 'Contraseña incorrecta.' };
    }

    this.currentUser = user;
    this.simulatedDispatcherMode = false;
    localStorage.removeItem(DISPATCHER_SIMULATION_KEY);
    localStorage.setItem(AUTH_STORAGE_KEY, user.id);
    this.notifyUserChange();

    return { success: true, user: this.currentUser };
  }

  /**
   * Valida si una contraseña ingresada coincide con algún Administrador de la base de datos local
   */
  async verifyAdminPassword(password) {
    const cleanPass = (password || '').trim();
    if (!cleanPass) return false;

    // Aceptar claves maestras por defecto de administración
    if (cleanPass === 'admin123' || cleanPass === 'admin' || cleanPass === '1234') {
      return true;
    }

    const users = await this.getAllUsers();
    const admins = users.filter(u => u.rol === ROLES.ADMIN);
    if (!admins.length) {
      return false;
    }
    return admins.some(admin => (admin.password || 'admin123') === cleanPass);
  }

  /**
   * Cierra la sesión activa y retorna a la pantalla de Login
   */
  logout() {
    this.currentUser = null;
    this.simulatedDispatcherMode = false;
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(DISPATCHER_SIMULATION_KEY);
    this.notifyUserChange();
  }

  async saveUser(userData) {
    const isNew = !userData.id;
    const rawUsername = userData.usuario || userData.email?.split('@')[0] || userData.nombre?.split(' ')[0] || 'usuario';
    const cleanUsername = rawUsername.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

    const user = {
      id: userData.id || 'USR-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 5),
      nombre: (userData.nombre || '').trim(),
      usuario: cleanUsername,
      password: (userData.password || '1234').trim(),
      email: (userData.email || '').trim(),
      telefono: (userData.telefono || '').trim(),
      rol: userData.rol === ROLES.DISPATCHER ? ROLES.DISPATCHER : ROLES.ADMIN,
      cargoTitulo: userData.rol === ROLES.DISPATCHER ? 'Despachador / Logística' : 'Administrador General',
      avatar: userData.rol === ROLES.DISPATCHER ? '🚚' : '👑',
      createdAt: userData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await storageService.put('users', user);
    supabaseService.pushRecord('users', user).catch(() => {});

    if (this.currentUser && this.currentUser.id === user.id) {
      this.currentUser = user;
      this.notifyUserChange();
    }

    return user;
  }

  async deleteUser(userId) {
    if (this.currentUser && this.currentUser.id === userId) {
      throw new Error('No puedes eliminar el usuario con el que tienes la sesión activa.');
    }
    const allUsers = await this.getAllUsers();
    if (allUsers.length <= 1) {
      throw new Error('Debe existir al menos un usuario en el sistema.');
    }
    supabaseService.pushDelete('users', userId).catch(() => {});
    return storageService.delete('users', userId);
  }

  async seedDefaultUsersIfEmpty() {
    const existing = await storageService.getAll('users');
    if (existing.length > 0) {
      // Migrar usuarios antiguos que no tenían campo usuario o password
      for (const u of existing) {
        let modified = false;
        if (!u.usuario) {
          u.usuario = u.rol === ROLES.ADMIN ? 'admin' : (u.nombre?.toLowerCase().split(' ')[0] || 'despacho');
          modified = true;
        }
        if (!u.password) {
          u.password = u.rol === ROLES.ADMIN ? 'admin123' : '1234';
          modified = true;
        }
        if (modified) {
          await storageService.put('users', u);
        }
      }
      return;
    }

    const defaultUsers = [
      {
        id: 'USR-ADMIN-1',
        nombre: 'Luis Administrador',
        usuario: 'admin',
        password: 'admin123',
        email: 'admin@encargosexpress.com',
        telefono: '+591 70000001',
        rol: ROLES.ADMIN,
        cargoTitulo: 'Administrador General',
        avatar: '👑',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'USR-DISPATCHER-1',
        nombre: 'Carlos Despachador',
        usuario: 'carlos',
        password: '1234',
        email: 'carlos.despacho@encargosexpress.com',
        telefono: '+591 70000002',
        rol: ROLES.DISPATCHER,
        cargoTitulo: 'Despachador / Logística',
        avatar: '🚚',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    for (const u of defaultUsers) {
      await storageService.put('users', u);
    }
  }
}

export const authService = new AuthService();
