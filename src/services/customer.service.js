/**
 * CustomerService - DeepSeek Harness Provider
 * Gestión de clientes, perfiles y cálculo dinámico de saldos (deudores / a favor).
 */

import { storageService } from './storage.service.js';
import { supabaseService } from './supabase.service.js';

class CustomerService {
  // Generar ID único
  generateId() {
    return 'CLI-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
  }

  // Obtener todos los clientes con sus balances calculados al vuelo
  async getCustomersWithBalances() {
    const customers = await storageService.getAll('customers');
    const orders = await storageService.getAll('orders');

    return customers.map(customer => {
      const customerOrders = orders.filter(o => o.clienteId === customer.id && o.estado !== 'cancelado');
      
      let saldoDeudorTotal = 0;
      let totalFacturado = 0;
      let totalAbonado = 0;

      customerOrders.forEach(order => {
        totalFacturado += (order.costoTotal || 0);
        totalAbonado += (order.totalAbonado || 0);
        saldoDeudorTotal += (order.saldoPendiente || 0);
      });

      return {
        ...customer,
        totalEncargos: customerOrders.length,
        totalFacturado: Math.round(totalFacturado * 100) / 100,
        totalAbonado: Math.round(totalAbonado * 100) / 100,
        saldoDeudorTotal: Math.round(saldoDeudorTotal * 100) / 100,
        saldoFavorTotal: (customer.saldoFavor || 0)
      };
    });
  }

  // Obtener un cliente por su ID con su perfil e historial completo
  async getCustomerProfile(customerId) {
    const customer = await storageService.getById('customers', customerId);
    if (!customer) return null;

    const allOrders = await storageService.getAll('orders');
    const orders = allOrders.filter(o => o.clienteId === customerId);

    // Ordenar pedidos por fecha más reciente
    orders.sort((a, b) => new Date(b.fechaCreacion) - new Date(a.fechaCreacion));

    let saldoDeudor = 0;
    let totalComprado = 0;
    let totalAbonado = 0;

    orders.forEach(order => {
      if (order.estado !== 'cancelado') {
        saldoDeudor += (order.saldoPendiente || 0);
        totalComprado += (order.costoTotal || 0);
        totalAbonado += (order.totalAbonado || 0);
      }
    });

    return {
      ...customer,
      saldoDeudorTotal: Math.round(saldoDeudor * 100) / 100,
      totalComprado: Math.round(totalComprado * 100) / 100,
      totalAbonado: Math.round(totalAbonado * 100) / 100,
      pedidos: orders
    };
  }

  // Crear o actualizar un cliente
  async saveCustomer(customerData) {
    const isNew = !customerData.id;
    const customer = {
      id: customerData.id || this.generateId(),
      nombre: customerData.nombre.trim(),
      telefono: customerData.telefono ? customerData.telefono.trim() : '',
      email: customerData.email ? customerData.email.trim() : '',
      documentoIdentidad: customerData.documentoIdentidad ? customerData.documentoIdentidad.trim() : '',
      ciudadDefault: customerData.ciudadDefault ? customerData.ciudadDefault.trim() : '',
      direccionDefault: customerData.direccionDefault ? customerData.direccionDefault.trim() : '',
      saldoFavor: Number(customerData.saldoFavor) || 0,
      notas: customerData.notas ? customerData.notas.trim() : '',
      createdAt: customerData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await storageService.put('customers', customer);
    supabaseService.pushRecord('customers', customer).catch(() => {});
    return customer;
  }

  // Eliminar un cliente (solo si no tiene pedidos pendientes)
  async deleteCustomer(customerId) {
    const orders = await storageService.getAll('orders');
    const hasActiveOrders = orders.some(o => o.clienteId === customerId && o.saldoPendiente > 0);
    if (hasActiveOrders) {
      throw new Error('No se puede eliminar un cliente con saldo deudor o pedidos activos pendientes de entrega.');
    }
    supabaseService.pushDelete('customers', customerId).catch(() => {});
    return storageService.delete('customers', customerId);
  }

  // Búsqueda de clientes por coincidencia de texto
  async searchCustomers(query) {
    if (!query) return this.getCustomersWithBalances();
    const q = query.toLowerCase().trim();
    const customers = await this.getCustomersWithBalances();
    return customers.filter(c => 
      c.nombre.toLowerCase().includes(q) ||
      (c.telefono && c.telefono.toLowerCase().includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q)) ||
      (c.ciudadDefault && c.ciudadDefault.toLowerCase().includes(q))
    );
  }
}

export const customerService = new CustomerService();
