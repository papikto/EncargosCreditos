/**
 * OrderService - DeepSeek Harness Provider
 * Motor de Encargos, Sistema por Apartado (Layaway), Abonos Parciales y Liquidación Rápida.
 */

import { storageService } from './storage.service.js';
import { supabaseService } from './supabase.service.js';

class OrderService {
  generateOrderId() {
    const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    return `ENC-${datePart}-${randomPart}`;
  }

  // Obtener todos los pedidos
  async getAllOrders() {
    const orders = await storageService.getAll('orders');
    return orders.sort((a, b) => new Date(b.fechaCreacion) - new Date(a.fechaCreacion));
  }

  // Obtener un pedido por ID
  async getOrderById(orderId) {
    return storageService.getById('orders', orderId);
  }

  // Crear o actualizar un encargo / apartado
  async saveOrder(orderData) {
    const isNew = !orderData.id;
    const now = new Date().toISOString();

    // Normalizar items y calcular costos
    const items = (orderData.items || []).map(item => ({
      id: item.id || 'itm-' + Math.random().toString(36).substring(2, 7),
      descripcion: item.descripcion.trim(),
      cantidad: Number(item.cantidad) || 1,
      precioUnitario: Number(item.precioUnitario) || 0,
      notas: item.notas ? item.notas.trim() : '',
      enlaceReferencia: item.enlaceReferencia ? item.enlaceReferencia.trim() : ''
    }));

    const costoItems = items.reduce((sum, item) => sum + (item.cantidad * item.precioUnitario), 0);
    const costoEnvioComision = Number(orderData.costoEnvioComision) || 0;
    const costoTotal = Math.round((costoItems + costoEnvioComision) * 100) / 100;

    // Cálculo del anticipo exigido
    const anticipoTipo = orderData.anticipoExigidoTipo || 'porcentaje'; // 'porcentaje' | 'fijo'
    let anticipoValor = Number(orderData.anticipoExigidoValor);
    if (isNaN(anticipoValor)) anticipoValor = 50;

    let montoAnticipoCalculado = 0;
    if (anticipoTipo === 'porcentaje') {
      montoAnticipoCalculado = Math.round((costoTotal * (anticipoValor / 100)) * 100) / 100;
    } else {
      montoAnticipoCalculado = Math.min(costoTotal, anticipoValor);
    }

    // Historial de abonos
    const historialAbonos = Array.isArray(orderData.historialAbonos) ? [...orderData.historialAbonos] : [];

    // Si es nuevo y se proporcionó un primer abono en la creación
    if (isNew && Number(orderData.primerAbono) > 0) {
      historialAbonos.push({
        id: 'abn-' + Date.now().toString(36),
        fecha: now,
        monto: Number(orderData.primerAbono),
        metodo: orderData.primerAbonoMetodo || 'Efectivo',
        comprobanteRef: orderData.primerAbonoRef || '',
        concepto: 'Anticipo inicial'
      });
    }

    // Calcular totales abonados y saldos
    const totalAbonado = Math.round(historialAbonos.reduce((acc, a) => acc + (Number(a.monto) || 0), 0) * 100) / 100;
    const saldoPendiente = Math.max(0, Math.round((costoTotal - totalAbonado) * 100) / 100);
    const porcentajePagado = costoTotal > 0 ? Math.min(100, Math.round((totalAbonado / costoTotal) * 100)) : 0;

    // Determinar estado financiero/logístico
    let estado = orderData.estado || 'pendiente_anticipo';
    if (saldoPendiente === 0 && costoTotal > 0) {
      if (estado !== 'entregado' && estado !== 'cancelado') {
        estado = 'liquidado_total';
      }
    } else if (totalAbonado >= montoAnticipoCalculado && totalAbonado > 0) {
      if (estado === 'pendiente_anticipo') {
        estado = 'anticipo_pagado';
      }
    }

    const order = {
      id: orderData.id || this.generateOrderId(),
      clienteId: orderData.clienteId,
      clienteNombre: orderData.clienteNombre,
      clienteTelefono: orderData.clienteTelefono || '',
      modalidad: orderData.modalidad || 'encargo_apartado',
      fechaCreacion: orderData.fechaCreacion || now,
      fechaEntregaEstimada: orderData.fechaEntregaEstimada || '',
      lugarDestino: {
        ciudad: (orderData.lugarDestino && orderData.lugarDestino.ciudad) ? orderData.lugarDestino.ciudad.trim() : 'Destino General',
        puntoEntrega: (orderData.lugarDestino && orderData.lugarDestino.puntoEntrega) ? orderData.lugarDestino.puntoEntrega.trim() : '',
        direccion: (orderData.lugarDestino && orderData.lugarDestino.direccion) ? orderData.lugarDestino.direccion.trim() : '',
        mapsUrl: (orderData.lugarDestino && orderData.lugarDestino.mapsUrl) ? orderData.lugarDestino.mapsUrl.trim() : '',
        lat: (orderData.lugarDestino && orderData.lugarDestino.lat) ? Number(orderData.lugarDestino.lat) : null,
        lng: (orderData.lugarDestino && orderData.lugarDestino.lng) ? Number(orderData.lugarDestino.lng) : null
      },
      items,
      costoItems: Math.round(costoItems * 100) / 100,
      costoEnvioComision,
      costoTotal,
      anticipoExigidoTipo: anticipoTipo,
      anticipoExigidoValor: anticipoValor,
      montoAnticipoCalculado,
      historialAbonos,
      totalAbonado,
      saldoPendiente,
      porcentajePagado,
      estado,
      notasInternas: orderData.notasInternas ? orderData.notasInternas.trim() : '',
      updatedAt: now
    };

    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Registrar un abono a un pedido (soporte de sistema por apartado)
  async addPayment(orderId, paymentData) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');

    const monto = Number(paymentData.monto);
    if (isNaN(monto) || monto <= 0) {
      throw new Error('El monto del abono debe ser mayor a 0');
    }

    const now = new Date().toISOString();
    const nuevoAbono = {
      id: 'abn-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 5),
      fecha: paymentData.fecha || now,
      monto: Math.round(monto * 100) / 100,
      metodo: paymentData.metodo || 'Efectivo',
      comprobanteRef: paymentData.comprobanteRef ? paymentData.comprobanteRef.trim() : '',
      concepto: paymentData.concepto || 'Abono / Cuota de apartado'
    };

    order.historialAbonos = order.historialAbonos || [];
    order.historialAbonos.push(nuevoAbono);

    // Recalcular
    order.totalAbonado = Math.round(order.historialAbonos.reduce((acc, a) => acc + (Number(a.monto) || 0), 0) * 100) / 100;
    order.saldoPendiente = Math.max(0, Math.round((order.costoTotal - order.totalAbonado) * 100) / 100);
    order.porcentajePagado = order.costoTotal > 0 ? Math.min(100, Math.round((order.totalAbonado / order.costoTotal) * 100)) : 100;

    // Actualizar estado si se liquidó
    if (order.saldoPendiente === 0) {
      if (order.estado !== 'entregado') {
        order.estado = 'liquidado_total';
      }
      order.fechaLiquidacion = now;
    } else if (order.totalAbonado >= order.montoAnticipoCalculado && order.estado === 'pendiente_anticipo') {
      order.estado = 'anticipo_pagado';
    }

    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return { order, nuevoAbono };
  }

  // Cancelación total / Liquidación inmediata en 1 clic
  async settleFullBalance(orderId, metodo = 'Efectivo', referencia = 'Liquidación total en 1 clic') {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');

    const saldoPendiente = order.saldoPendiente;
    if (saldoPendiente <= 0) {
      throw new Error('Este pedido ya se encuentra completamente pagado (saldo pendiente 0).');
    }

    return this.addPayment(orderId, {
      monto: saldoPendiente,
      metodo: metodo,
      comprobanteRef: referencia,
      concepto: 'Cancelación total / Liquidación de saldo'
    });
  }

  // Cambiar estado logístico del encargo
  async updateOrderStatus(orderId, nuevoEstado) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');
    order.estado = nuevoEstado;
    order.updatedAt = new Date().toISOString();
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Eliminar un encargo
  async deleteOrder(orderId) {
    supabaseService.pushDelete('orders', orderId).catch(() => {});
    return storageService.delete('orders', orderId);
  }

  // Búsqueda inteligente: filtra por cliente, por producto encargado o por código
  async searchOrdersAndProducts(query) {
    const orders = await this.getAllOrders();
    if (!query) return orders;

    const q = query.toLowerCase().trim();

    return orders.filter(order => {
      // Coincidencia con código de encargo
      if (order.id.toLowerCase().includes(q)) return true;
      // Coincidencia con nombre o teléfono del cliente
      if (order.clienteNombre && order.clienteNombre.toLowerCase().includes(q)) return true;
      if (order.clienteTelefono && order.clienteTelefono.toLowerCase().includes(q)) return true;
      // Coincidencia con ciudad de destino
      if (order.lugarDestino && order.lugarDestino.ciudad && order.lugarDestino.ciudad.toLowerCase().includes(q)) return true;
      // Coincidencia con productos encargados
      const matchProduct = (order.items || []).some(item => 
        item.descripcion.toLowerCase().includes(q) ||
        (item.notas && item.notas.toLowerCase().includes(q))
      );
      if (matchProduct) return true;

      return false;
    });
  }

  // Estadísticas para el Dashboard
  async getDashboardMetrics() {
    const orders = await this.getAllOrders();
    const activeOrders = orders.filter(o => o.estado !== 'cancelado');

    let totalPorCobrar = 0;       // Saldo deudor global acumulado
    let totalRecaudado = 0;        // Total recaudado en abonos y anticipos
    let totalFacturado = 0;        // Valor total de todos los pedidos activos
    let pendientesAnticipoCount = 0;
    let apartadosEnAbonosCount = 0;
    let liquidadosCount = 0;
    let entregadosCount = 0;

    const destinosMap = {};

    activeOrders.forEach(o => {
      totalPorCobrar += (o.saldoPendiente || 0);
      totalRecaudado += (o.totalAbonado || 0);
      totalFacturado += (o.costoTotal || 0);

      if (o.estado === 'pendiente_anticipo') pendientesAnticipoCount++;
      else if (o.saldoPendiente > 0) apartadosEnAbonosCount++;
      else if (o.estado === 'liquidado_total') liquidadosCount++;
      else if (o.estado === 'entregado') entregadosCount++;

      // Agrupación por ciudad
      const ciudad = (o.lugarDestino && o.lugarDestino.ciudad) ? o.lugarDestino.ciudad : 'Sin destino';
      if (!destinosMap[ciudad]) {
        destinosMap[ciudad] = { ciudad, cantidad: 0, saldoPendiente: 0, totalAbonado: 0 };
      }
      destinosMap[ciudad].cantidad++;
      destinosMap[ciudad].saldoPendiente += (o.saldoPendiente || 0);
      destinosMap[ciudad].totalAbonado += (o.totalAbonado || 0);
    });

    return {
      totalPorCobrar: Math.round(totalPorCobrar * 100) / 100,
      totalRecaudado: Math.round(totalRecaudado * 100) / 100,
      totalFacturado: Math.round(totalFacturado * 100) / 100,
      totalPedidos: activeOrders.length,
      pendientesAnticipoCount,
      apartadosEnAbonosCount,
      liquidadosCount,
      destinos: Object.values(destinosMap).sort((a, b) => b.cantidad - a.cantidad)
    };
  }

  // Generar URL para abrir directamente Google Maps en modo ruta / navegación
  getMapsRouteUrl(lugarDestino) {
    if (!lugarDestino) return 'https://www.google.com/maps';

    // Si es un string simple (ej. el nombre de una ciudad)
    if (typeof lugarDestino === 'string') {
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lugarDestino)}`;
    }

    // Si ya tiene link de Maps guardado directamente (ej. link compartido de WhatsApp)
    if (lugarDestino.mapsUrl && lugarDestino.mapsUrl.startsWith('http')) {
      return lugarDestino.mapsUrl;
    }

    // Si tiene coordenadas GPS exactas
    if (lugarDestino.lat && lugarDestino.lng) {
      return `https://www.google.com/maps/dir/?api=1&destination=${lugarDestino.lat},${lugarDestino.lng}`;
    }

    // Combinar dirección, punto de entrega y ciudad para la mejor precisión
    const parts = [];
    if (lugarDestino.direccion) parts.push(lugarDestino.direccion);
    if (lugarDestino.puntoEntrega) parts.push(lugarDestino.puntoEntrega);
    if (lugarDestino.ciudad) parts.push(lugarDestino.ciudad);

    const query = parts.join(', ').trim();
    if (!query) return 'https://www.google.com/maps';

    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
  }
}

export const orderService = new OrderService();
